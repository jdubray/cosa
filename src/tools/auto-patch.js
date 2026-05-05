'use strict';

const { exec: childExec } = require('node:child_process');
const { promisify }       = require('node:util');
const sshBackend          = require('../ssh-backend');

const execLocal = promisify(childExec);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'auto_patch';
const RISK_LEVEL = 'destructive';

const APT_LOCK_TIMEOUT_SEC = 300;
const APT_UPDATE_CMD =
  `sudo apt-get update -o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SEC}`;
const APT_UPGRADE_CMD =
  'sudo DEBIAN_FRONTEND=noninteractive apt-get -y ' +
  `-o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SEC} ` +
  '-o Dpkg::Options::="--force-confdef" ' +
  '-o Dpkg::Options::="--force-confold" ' +
  'upgrade';
const REBOOT_FLAG_PATH = '/var/run/reboot-required';

const APT_TIMEOUT_MS  = 30 * 60 * 1000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const LOG_TAIL_BYTES = 4096;

const VALID_TARGETS = ['cosa', 'appliance'];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    target:             { type: 'string', enum: VALID_TARGETS },
    rebootIfRequired:   { type: 'boolean' },
    rebootDelayMinutes: { type: 'integer', minimum: 1, maximum: 60 },
  },
  required:             ['target'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Run apt-get update and a full apt-get upgrade on either the COSA host (target=cosa) ' +
    'or the managed appliance (target=appliance, via SSH). Detects ' +
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
async function handler({ target, rebootIfRequired = true, rebootDelayMinutes = 1 } = {}) {
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`auto_patch: invalid target '${target}' (expected one of ${VALID_TARGETS.join(', ')})`);
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

  const startedAt = Date.now();
  let combined   = '';

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

  // 2. apt-get upgrade
  const upgradeRes = await _execTarget(target, APT_UPGRADE_CMD);
  combined += `$ ${APT_UPGRADE_CMD}\n${upgradeRes.stdout}\n${upgradeRes.stderr}\n`;
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

  // 3. Reboot flag
  const flagRes = await _execTarget(target, `test -f ${REBOOT_FLAG_PATH}`);
  const rebootRequired = flagRes.exitCode === 0;

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
