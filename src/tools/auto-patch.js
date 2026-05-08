'use strict';

const { exec: childExec } = require('node:child_process');
const { promisify }       = require('node:util');
const sshBackend          = require('../ssh-backend');

const execLocal = promisify(childExec);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'auto_patch';
const RISK_LEVEL = 'high';

const APT_LOCK_TIMEOUT_SEC = 300;
const APT_UPDATE_CMD =
  `sudo apt-get update -o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SEC}`;

/**
 * Build the apt-get upgrade command for the chosen mode.
 *   - 'upgrade'      → conservative; never installs new packages or removes
 *                      any. Safe for production. Holds back updates whose new
 *                      version pulls in a renamed dependency.
 *   - 'full-upgrade' → resolves dependency changes; will install new
 *                      transitional packages and may remove obsolete ones.
 *                      Catches kernel meta-package updates that 'upgrade'
 *                      keeps back. Slightly more invasive.
 *
 * @param {'upgrade'|'full-upgrade'} mode
 * @returns {string}
 */
function _buildUpgradeCmd(mode) {
  return (
    'sudo DEBIAN_FRONTEND=noninteractive apt-get -y ' +
    `-o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SEC} ` +
    '-o Dpkg::Options::="--force-confdef" ' +
    '-o Dpkg::Options::="--force-confold" ' +
    mode
  );
}
const REBOOT_FLAG_PATH = '/var/run/reboot-required';

const APT_TIMEOUT_MS  = 30 * 60 * 1000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const LOG_TAIL_BYTES = 4096;

const VALID_TARGETS       = ['cosa', 'appliance'];
const VALID_UPGRADE_MODES = ['upgrade', 'full-upgrade'];
const DEFAULT_UPGRADE_MODE = 'upgrade';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    target:             { type: 'string',  enum: VALID_TARGETS },
    upgradeMode:        { type: 'string',  enum: VALID_UPGRADE_MODES },
    rebootIfRequired:   { type: 'boolean' },
    rebootDelayMinutes: { type: 'integer', minimum: 1, maximum: 60 },
  },
  required:             ['target'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Run apt-get update and an apt-get upgrade on either the COSA host (target=cosa) ' +
    'or the managed appliance (target=appliance, via SSH). The upgrade phase is either ' +
    `'upgrade' (conservative; default) or 'full-upgrade' (resolves dependency changes; ` +
    `catches kernel meta-package updates that 'upgrade' holds back). Detects ` +
    `${REBOOT_FLAG_PATH} and optionally schedules a delayed reboot. Returns ok, ` +
    'packagesUpgraded, rebootRequired, rebootScheduled, durationMs, logTail, and error.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to its trailing N bytes, prefixed with an ellipsis when
 * truncated. Keeps email bodies bounded — apt output can run to thousands of
 * lines on a long-pending appliance.
 *
 * @param {string} s
 * @param {number} bytes
 * @returns {string}
 */
function _tail(s, bytes) {
  if (typeof s !== 'string') return '';
  return s.length <= bytes ? s : '…(truncated)…\n' + s.slice(-bytes);
}

/**
 * Count "Setting up <pkg>" lines in apt output as a rough upgraded-package
 * count. apt does not expose a structured count without dpkg parsing.
 *
 * @param {string} stdout
 * @returns {number}
 */
function _countUpgraded(stdout) {
  if (typeof stdout !== 'string') return 0;
  const matches = stdout.match(/^Setting up /gm);
  return matches ? matches.length : 0;
}

/**
 * Run a shell command on the chosen target.
 *
 * cosa      → local exec via child_process.
 * appliance → remote exec via ssh-backend.
 *
 * Always resolves with a uniform shape; never throws on a non-zero exit, a
 * connection drop, or a timeout. Callers can branch on exitCode without
 * try/catch around every call.
 *
 * @param {'cosa'|'appliance'} target
 * @param {string}             command
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function _execTarget(target, command) {
  if (target === 'cosa') {
    try {
      const { stdout, stderr } = await execLocal(command, {
        timeout:   APT_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
      });
      return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout:   err.stdout ?? '',
        stderr:   err.stderr ?? err.message ?? '',
      };
    }
  }
  try {
    return await sshBackend.exec(command, null, APT_TIMEOUT_MS);
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err.message ?? String(err) };
  }
}

/**
 * Decide whether the target host needs a reboot after apt upgrade.
 *
 * Two complementary signals are checked:
 *
 *   1. The standard Debian/Ubuntu marker `/var/run/reboot-required`. This is
 *      created by `update-notifier-common`'s apt hook on releases that ship
 *      it. Authoritative when present.
 *
 *   2. Initramfs-newer-than-boot. Raspberry Pi OS does NOT ship
 *      `update-notifier-common`, so the marker is never written even after
 *      a kernel upgrade. As a fallback we check whether any boot initramfs
 *      file has an mtime newer than the running kernel's boot time. If apt
 *      regenerated initramfs (for a new kernel, glibc, etc.) since we
 *      booted, a reboot is needed.
 *
 * Either signal triggering is sufficient. Returns true if either says yes.
 *
 * @param {'cosa'|'appliance'} target
 * @returns {Promise<boolean>}
 */
async function _checkRebootRequired(target) {
  const flagRes = await _execTarget(target, `test -f ${REBOOT_FLAG_PATH}`);
  if (flagRes.exitCode === 0) return true;

  // Pi OS fallback: any of these initramfs files newer than boot time?
  // - /boot/firmware/initramfs8           Pi 4 and earlier on Pi OS Bookworm+
  // - /boot/firmware/initramfs_2712       Pi 5 on Pi OS Bookworm+
  // - /boot/initrd.img-*                  Generic Debian/Ubuntu fallback
  const cmd =
    'b=$(date -d "$(uptime -s)" +%s) && ' +
    'for f in /boot/firmware/initramfs8 /boot/firmware/initramfs_2712 /boot/initrd.img-*; do ' +
      '[ -f "$f" ] && [ "$(stat -c %Y "$f")" -gt "$b" ] && exit 0; ' +
    'done; exit 1';
  const initramfsRes = await _execTarget(target, cmd);
  return initramfsRes.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ target: 'cosa'|'appliance', rebootIfRequired?: boolean, rebootDelayMinutes?: number }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   target: string,
 *   packagesUpgraded: number,
 *   rebootRequired: boolean,
 *   rebootScheduled: boolean,
 *   durationMs: number,
 *   logTail: string,
 *   error: string|null
 * }>}
 */
async function handler({
  target,
  upgradeMode        = DEFAULT_UPGRADE_MODE,
  rebootIfRequired   = true,
  rebootDelayMinutes = 1,
} = {}) {
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`auto_patch: invalid target '${target}' (expected one of ${VALID_TARGETS.join(', ')})`);
  }
  if (!VALID_UPGRADE_MODES.includes(upgradeMode)) {
    throw new Error(
      `auto_patch: invalid upgradeMode '${upgradeMode}' (expected one of ${VALID_UPGRADE_MODES.join(', ')})`
    );
  }
  if (target === 'appliance' && !sshBackend.isConnected()) {
    return {
      ok:               false,
      target,
      packagesUpgraded: 0,
      rebootRequired:   false,
      rebootScheduled:  false,
      durationMs:       0,
      logTail:          '',
      error:            'SSH backend not connected',
    };
  }

  const startedAt     = Date.now();
  const aptUpgradeCmd = _buildUpgradeCmd(upgradeMode);
  let combined        = '';

  // 1. apt-get update
  const updateRes = await _execTarget(target, APT_UPDATE_CMD);
  combined += `$ ${APT_UPDATE_CMD}\n${updateRes.stdout}\n${updateRes.stderr}\n`;
  if (updateRes.exitCode !== 0) {
    return {
      ok:               false,
      target,
      packagesUpgraded: 0,
      rebootRequired:   false,
      rebootScheduled:  false,
      durationMs:       Date.now() - startedAt,
      logTail:          _tail(combined, LOG_TAIL_BYTES),
      error:            `apt-get update failed (exit ${updateRes.exitCode})`,
    };
  }

  // 2. apt-get upgrade / full-upgrade (per upgradeMode)
  const upgradeRes = await _execTarget(target, aptUpgradeCmd);
  combined += `$ ${aptUpgradeCmd}\n${upgradeRes.stdout}\n${upgradeRes.stderr}\n`;
  const packagesUpgraded = _countUpgraded(upgradeRes.stdout);
  if (upgradeRes.exitCode !== 0) {
    return {
      ok:               false,
      target,
      packagesUpgraded,
      rebootRequired:   false,
      rebootScheduled:  false,
      durationMs:       Date.now() - startedAt,
      logTail:          _tail(combined, LOG_TAIL_BYTES),
      error:            `apt-get upgrade failed (exit ${upgradeRes.exitCode})`,
    };
  }

  // 3. Reboot detection — see _checkRebootRequired for the two-pronged check.
  const rebootRequired = await _checkRebootRequired(target);

  // 4. Schedule reboot if needed.  Use a delay so the cron task can finish
  //    sending its notification email before the host goes down.
  let rebootScheduled = false;
  if (rebootRequired && rebootIfRequired) {
    const rebootCmd = `sudo shutdown -r +${rebootDelayMinutes}`;
    const rebootRes = await _execTarget(target, rebootCmd);
    combined += `$ ${rebootCmd}\n${rebootRes.stdout}\n${rebootRes.stderr}\n`;
    if (rebootRes.exitCode === 0) {
      rebootScheduled = true;
    } else {
      return {
        ok:               false,
        target,
        packagesUpgraded,
        rebootRequired,
        rebootScheduled:  false,
        durationMs:       Date.now() - startedAt,
        logTail:          _tail(combined, LOG_TAIL_BYTES),
        error:            `Reboot scheduling failed (exit ${rebootRes.exitCode})`,
      };
    }
  }

  return {
    ok:               true,
    target,
    packagesUpgraded,
    rebootRequired,
    rebootScheduled,
    durationMs:       Date.now() - startedAt,
    logTail:          _tail(combined, LOG_TAIL_BYTES),
    error:            null,
  };
}

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
