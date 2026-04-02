'use strict';

const sshBackend        = require('../ssh-backend');
const { getConfig }     = require('../../config/cosa.config');
const { createLogger }  = require('../logger');

const log = createLogger('compliance-verify');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'compliance_verify';
const RISK_LEVEL = 'read';

// Static SSH commands — never constructed from user input.
const CMD_SSHD_PASSWORD_AUTH  = 'grep -i "PasswordAuthentication" /etc/ssh/sshd_config';
const CMD_SSHD_PERMIT_ROOT    = 'grep -i "PermitRootLogin" /etc/ssh/sshd_config';
const CMD_SSHD_MAX_AUTH_TRIES = 'grep -i "MaxAuthTries" /etc/ssh/sshd_config';
const CMD_SS                  = 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';

/** Build a `stat` command that prints `<octal-mode> <path>` for each path. */
function buildStatCmd(paths) {
  // stat -c '%a %n' — outputs octal perms and name; safe: paths come from config.
  const escaped = paths.map((p) => `"${p}"`).join(' ');
  return `stat -c '%a %n' ${escaped} 2>&1`;
}

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Verify the Baanbaan server configuration against a hardening baseline. ' +
    'Checks sshd_config (PasswordAuthentication, PermitRootLogin, MaxAuthTries), ' +
    'file permissions on sensitive files (.env, merchant.db), and listening ' +
    'services against the expected port list. ' +
    'Returns a findings array of { check, status, evidence } objects where ' +
    "status is 'pass', 'fail', or 'warning'.",
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// sshd_config parsing
// ---------------------------------------------------------------------------

/**
 * Parse grep output for a single sshd_config directive.
 * Returns the value of the *first uncommented* matching line, or null if none.
 *
 * Lines that start with `#` (after optional whitespace) are comments.
 *
 * @param {string} stdout
 * @returns {string | null}  The directive value token(s) after the keyword.
 */
function parseSshdOption(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Split on first run of whitespace: keyword value [value2 ...]
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      return parts.slice(1).join(' ').toLowerCase();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check builders — each returns a finding object
// ---------------------------------------------------------------------------

/**
 * @param {{ exitCode: number, stdout: string }} result
 * @returns {{ check: string, status: 'pass'|'fail'|'warning', evidence: string }}
 */
function checkPasswordAuthentication(result) {
  const CHECK = 'sshd_config.PasswordAuthentication';

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    // grep found nothing — OpenSSH default is `yes` in most distros.
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'PasswordAuthentication not explicitly set; OpenSSH default is "yes". Set explicitly to "no".',
    };
  }

  const value = parseSshdOption(result.stdout);

  if (value === null) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'PasswordAuthentication line exists but only as comment(s). Effective default may be "yes".',
    };
  }

  if (value === 'no') {
    return { check: CHECK, status: 'pass', evidence: `PasswordAuthentication ${value}` };
  }

  return {
    check:    CHECK,
    status:   'fail',
    evidence: `PasswordAuthentication is "${value}". Must be "no" to prevent brute-force attacks.`,
  };
}

/**
 * @param {{ exitCode: number, stdout: string }} result
 * @returns {{ check: string, status: 'pass'|'fail'|'warning', evidence: string }}
 */
function checkPermitRootLogin(result) {
  const CHECK = 'sshd_config.PermitRootLogin';

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'PermitRootLogin not explicitly set; OpenSSH ≥ 7.0 defaults to "prohibit-password", earlier defaults to "yes". Set explicitly.',
    };
  }

  const value = parseSshdOption(result.stdout);

  if (value === null) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'PermitRootLogin line exists but only as comment(s). Effective value is the OpenSSH default.',
    };
  }

  // Acceptable: no, prohibit-password (modern alias), without-password (legacy alias)
  const SAFE = new Set(['no', 'prohibit-password', 'without-password']);
  if (SAFE.has(value)) {
    return { check: CHECK, status: 'pass', evidence: `PermitRootLogin ${value}` };
  }

  // Warn on forced-commands-only (not ideal but not a direct login risk)
  if (value === 'forced-commands-only') {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: `PermitRootLogin ${value} — root can connect but only with forced commands. Consider "no".`,
    };
  }

  return {
    check:    CHECK,
    status:   'fail',
    evidence: `PermitRootLogin is "${value}". Must be "no" or "prohibit-password" to prevent direct root login.`,
  };
}

/**
 * @param {{ exitCode: number, stdout: string }} result
 * @returns {{ check: string, status: 'pass'|'fail'|'warning', evidence: string }}
 */
function checkMaxAuthTries(result) {
  const CHECK    = 'sshd_config.MaxAuthTries';
  const EXPECTED = 3;

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'MaxAuthTries not explicitly set; OpenSSH default is 6. Set to 3 to limit brute-force attempts.',
    };
  }

  const value = parseSshdOption(result.stdout);

  if (value === null) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: 'MaxAuthTries line exists but only as comment(s). Effective value is the OpenSSH default (6).',
    };
  }

  const numeric = parseInt(value, 10);

  if (isNaN(numeric)) {
    return {
      check:    CHECK,
      status:   'warning',
      evidence: `MaxAuthTries has unexpected value "${value}". Could not parse as integer.`,
    };
  }

  if (numeric === EXPECTED) {
    return { check: CHECK, status: 'pass', evidence: `MaxAuthTries ${numeric}` };
  }

  if (numeric <= EXPECTED) {
    // Stricter than required — pass with note.
    return {
      check:    CHECK,
      status:   'pass',
      evidence: `MaxAuthTries ${numeric} (at or below required limit of ${EXPECTED}).`,
    };
  }

  return {
    check:    CHECK,
    status:   'fail',
    evidence: `MaxAuthTries is ${numeric}. Must be ≤ ${EXPECTED} to limit brute-force auth attempts.`,
  };
}

// ---------------------------------------------------------------------------
// File permissions parsing
// ---------------------------------------------------------------------------

/**
 * Parse `stat -c '%a %n'` output into a map of path → octal-mode-string.
 *
 * @param {string} stdout
 * @returns {Map<string, string>}  path → octal string (e.g. '600', '644').
 */
function parseStatOutput(stdout) {
  const result = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx < 1) continue;
    const mode = trimmed.slice(0, spaceIdx);
    const path = trimmed.slice(spaceIdx + 1);
    result.set(path, mode);
  }
  return result;
}

/**
 * Evaluate file permissions against hardening expectations.
 *
 * Rules:
 *   • World-readable (others read bit set) → fail
 *   • Group-readable  (group read bit set)  → warning
 *   • Otherwise                             → pass
 *
 * We only inspect the read bits because write and execute bits carry their
 * own risk but are out of scope for this check.
 *
 * @param {string} checkName
 * @param {string} path
 * @param {string | undefined} modeStr  Octal string, e.g. '640'.
 * @returns {{ check: string, status: 'pass'|'fail'|'warning', evidence: string }}
 */
function evaluateFilePermissions(checkName, path, modeStr) {
  if (!modeStr) {
    return {
      check:    checkName,
      status:   'warning',
      evidence: `${path} — stat output not found (file may not exist or be inaccessible).`,
    };
  }

  const octal = parseInt(modeStr, 8);
  if (isNaN(octal)) {
    return {
      check:    checkName,
      status:   'warning',
      evidence: `${path} — could not parse permissions "${modeStr}".`,
    };
  }

  const othersRead = (octal & 0o004) !== 0;
  const groupRead  = (octal & 0o040) !== 0;

  if (othersRead) {
    return {
      check:    checkName,
      status:   'fail',
      evidence: `${path} has world-readable permissions (${modeStr}). Others can read this file.`,
    };
  }

  if (groupRead) {
    return {
      check:    checkName,
      status:   'warning',
      evidence: `${path} is group-readable (${modeStr}). Verify group membership is appropriately restricted.`,
    };
  }

  return {
    check:    checkName,
    status:   'pass',
    evidence: `${path} permissions: ${modeStr}`,
  };
}

// ---------------------------------------------------------------------------
// Listening ports check
// ---------------------------------------------------------------------------

/**
 * Parse `ss -tlnp` / `netstat -tlnp` into unique sorted port numbers.
 * (Reuses the same logic as process-monitor.)
 *
 * @param {string} stdout
 * @returns {number[]}
 */
function parseListeningPorts(stdout) {
  const ports = new Set();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('State') || trimmed.startsWith('Proto')) continue;
    for (const match of trimmed.matchAll(/:(\d+)(?:\s|$)/g)) {
      const port = parseInt(match[1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * @param {number[]} listeningPorts
 * @param {Set<number>} knownPortSet
 * @returns {{ check: string, status: 'pass'|'fail'|'warning', evidence: string }}
 */
function checkListeningServices(listeningPorts, knownPortSet) {
  const CHECK   = 'listening_services';
  const unknown = listeningPorts.filter((p) => !knownPortSet.has(p));

  if (unknown.length === 0) {
    return {
      check:    CHECK,
      status:   'pass',
      evidence: `All listening ports are known: [${listeningPorts.join(', ')}]`,
    };
  }

  return {
    check:    CHECK,
    status:   'fail',
    evidence:
      `Unknown listening port(s) detected: [${unknown.join(', ')}]. ` +
      `Known ports: [${[...knownPortSet].sort((a, b) => a - b).join(', ')}]. ` +
      'Investigate and add to appliance.yaml if legitimate.',
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary:        string,
 *   findings:       Array<{ check: string, status: 'pass'|'fail'|'warning', evidence: string }>,
 *   pass_count:     number,
 *   fail_count:     number,
 *   warning_count:  number,
 *   checked_at:     string
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();
  const { appliance } = getConfig();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run compliance_verify');
  }

  // ── Gather configurable file paths ───────────────────────────────────────
  const sensitiveFiles = appliance.tools?.compliance_verify?.sensitive_files ?? [
    '/home/weather/.env',
    '/home/weather/merchant.db',
  ];
  const knownPortSet = new Set(
    (appliance.monitoring?.known_ports ?? []).map(Number)
  );

  // ── Fire all SSH commands in parallel ────────────────────────────────────
  const statCmd = buildStatCmd(sensitiveFiles);

  const [
    passwdAuthResult,
    permitRootResult,
    maxAuthTriesResult,
    statResult,
    ssResult,
  ] = await Promise.all([
    sshBackend.exec(CMD_SSHD_PASSWORD_AUTH),
    sshBackend.exec(CMD_SSHD_PERMIT_ROOT),
    sshBackend.exec(CMD_SSHD_MAX_AUTH_TRIES),
    sshBackend.exec(statCmd),
    sshBackend.exec(CMD_SS),
  ]);

  // ── Build findings ───────────────────────────────────────────────────────
  const findings = [];

  // 1–3: sshd_config
  findings.push(checkPasswordAuthentication(passwdAuthResult));
  findings.push(checkPermitRootLogin(permitRootResult));
  findings.push(checkMaxAuthTries(maxAuthTriesResult));

  // 4: file permissions
  const statMap = parseStatOutput(statResult.stdout);
  for (const filePath of sensitiveFiles) {
    const checkName = `file_permissions.${filePath.split('/').pop()}`;
    findings.push(evaluateFilePermissions(checkName, filePath, statMap.get(filePath)));
  }

  // 5: listening services
  const listeningPorts = parseListeningPorts(ssResult.stdout);
  findings.push(checkListeningServices(listeningPorts, knownPortSet));

  // ── Tally ────────────────────────────────────────────────────────────────
  const passCount    = findings.filter((f) => f.status === 'pass').length;
  const failCount    = findings.filter((f) => f.status === 'fail').length;
  const warningCount = findings.filter((f) => f.status === 'warning').length;

  const summary =
    failCount > 0
      ? `${failCount} compliance failure(s), ${warningCount} warning(s), ${passCount} passed.`
      : warningCount > 0
        ? `All checks passed with ${warningCount} warning(s).`
        : `All ${passCount} checks passed.`;

  log.info(`compliance_verify complete: ${summary}`);

  return {
    summary,
    findings,
    pass_count:    passCount,
    fail_count:    failCount,
    warning_count: warningCount,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
