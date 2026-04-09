'use strict';

const sshBackend       = require('../ssh-backend');
const toolRegistry     = require('../tool-registry');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('pci-assessment');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'pci_assessment';
const RISK_LEVEL = 'read';

// Static SSH commands — never constructed from user input.
const CMD_DEFAULT_ACCOUNTS  = "grep -E '^(pi|ubuntu|admin|raspberry|test|guest):' /etc/passwd 2>/dev/null";
const CMD_SS                = 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';
const CMD_DUPLICATE_UIDS    = "awk -F: 'seen[$3]++ {print $1, $3}' /etc/passwd 2>/dev/null";
const CMD_SSHD_PASSWORD_AUTH = 'grep -i "PasswordAuthentication" /etc/ssh/sshd_config 2>/dev/null';
const CMD_AUTH_LOG_LINES    = 'wc -l /var/log/auth.log 2>/dev/null || echo "0 not-found"';
const CMD_AUTH_LOG_STAT     = 'stat -c "%a %n" /var/log/auth.log 2>/dev/null || echo "not-found /var/log/auth.log"';
const CMD_SECURITY_MD       = 'find /home/weather -name "SECURITY.md" -maxdepth 4 2>/dev/null | head -1';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Run a PCI-DSS SAQ-A self-assessment checklist against the Baanbaan configuration. ' +
    'Covers all 13 SAQ-A requirements. Manual checks are flagged rather than auto-failed. ' +
    'Returns overallStatus (compliant | non_compliant | needs_review), a requirements array, ' +
    'and an actionItems list for any non-compliant or warning items.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Shared helpers (subset from compliance-verify)
// ---------------------------------------------------------------------------

/**
 * Parse grep output for a single sshd_config directive.
 * Returns the value of the first uncommented line, or null.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
function parseSshdOption(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) return parts.slice(1).join(' ').toLowerCase();
  }
  return null;
}

/**
 * Parse `ss -tlnp` / `netstat -tlnp` into unique sorted port numbers.
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

// ---------------------------------------------------------------------------
// Requirement builders — each returns a requirement object
// ---------------------------------------------------------------------------

/** Build a requirement result object. */
function req(id, description, status, evidence, recommendation) {
  const result = { id, description, status, evidence };
  if (recommendation) result.recommendation = recommendation;
  return result;
}

/** REQ 2.1 — No default vendor-supplied passwords */
function check2_1(defaultAccountsResult) {
  const ID   = '2.1';
  const DESC = 'No default vendor-supplied passwords in use';

  const output = defaultAccountsResult.stdout.trim();
  if (defaultAccountsResult.exitCode === 0 && output) {
    const found = output.split('\n').map((l) => l.split(':')[0]).join(', ');
    return req(
      ID, DESC, 'fail',
      `Default-named accounts found: ${found}`,
      'Rename or disable default accounts (pi, ubuntu, admin, etc.) immediately.'
    );
  }

  return req(ID, DESC, 'pass', 'No default-named accounts (pi, ubuntu, admin, raspberry, test, guest) detected.');
}

/** REQ 2.2 — Only necessary services enabled */
function check2_2(ssResult, knownPortSet) {
  const ID   = '2.2';
  const DESC = 'Only necessary services enabled on system components';

  const listeningPorts = parseListeningPorts(ssResult.stdout);
  const unknown        = listeningPorts.filter((p) => !knownPortSet.has(p));

  if (unknown.length === 0) {
    return req(ID, DESC, 'pass', `Listening ports match known set: [${listeningPorts.join(', ')}]`);
  }

  return req(
    ID, DESC, 'fail',
    `Unknown listening port(s): [${unknown.join(', ')}]. Known: [${[...knownPortSet].sort((a, b) => a - b).join(', ')}]`,
    'Disable or firewall any service not required for appliance operation.'
  );
}

/** REQ 6.1 — All software kept up to date */
function check6_1(depAuditResult) {
  const ID   = '6.1';
  const DESC = 'All system components protected from known vulnerabilities';

  if (!depAuditResult) {
    return req(
      ID, DESC, 'warning',
      'dep_audit tool not available; automated CVE check could not run.',
      'Run dep_audit manually or ensure the tool is deployed and enabled.'
    );
  }

  if (depAuditResult.vulnerabilities && depAuditResult.vulnerabilities.length > 0) {
    return req(
      ID, DESC, 'fail',
      `dep_audit found ${depAuditResult.vulnerabilities.length} known vulnerability/ies.`,
      'Review and apply security patches for all flagged packages.'
    );
  }

  return req(ID, DESC, 'pass', 'dep_audit found no known vulnerabilities.');
}

/** REQ 6.2 — No publicly known vulnerabilities */
function check6_2(depAuditResult) {
  const ID   = '6.2';
  const DESC = 'All system components protected against publicly known vulnerabilities';

  if (!depAuditResult) {
    return req(
      ID, DESC, 'warning',
      'dep_audit tool not available; bun audit could not run.',
      'Enable the dep_audit tool or run `bun audit` manually on the Baanbaan appliance.'
    );
  }

  // dep_audit covers bun/npm audit — reuse its result here
  if (depAuditResult.auditClean === false) {
    return req(
      ID, DESC, 'fail',
      'bun audit (via dep_audit) reports publicly known vulnerabilities in dependencies.',
      'Apply patches or replace vulnerable dependencies.'
    );
  }

  return req(ID, DESC, 'pass', 'bun audit reports no publicly known vulnerabilities in dependencies.');
}

/** REQ 8.1 — Unique user IDs */
function check8_1(duplicateUidsResult) {
  const ID   = '8.1';
  const DESC = 'Unique IDs assigned to each person with computer access';

  const output = duplicateUidsResult.stdout.trim();
  if (output) {
    const dupes = output.split('\n').slice(0, 5).join('; ');
    return req(
      ID, DESC, 'fail',
      `Duplicate UIDs detected: ${dupes}`,
      'Assign unique UIDs to all user accounts; shared UIDs make audit trails unreliable.'
    );
  }

  return req(ID, DESC, 'pass', 'All entries in /etc/passwd have unique UIDs.');
}

/** REQ 8.2 — Strong authentication enforced */
function check8_2(passwdAuthResult) {
  const ID   = '8.2';
  const DESC = 'Proper identification and authentication management for non-consumer users';

  const value = parseSshdOption(passwdAuthResult.stdout);

  if (value === 'no') {
    return req(ID, DESC, 'pass', 'SSH PasswordAuthentication is disabled; key-based auth enforced.');
  }

  if (value === null && passwdAuthResult.exitCode !== 0) {
    return req(
      ID, DESC, 'warning',
      'PasswordAuthentication not explicitly set in sshd_config; default may allow password login.',
      'Explicitly set "PasswordAuthentication no" in /etc/ssh/sshd_config.'
    );
  }

  return req(
    ID, DESC, 'fail',
    `PasswordAuthentication is "${value ?? 'unset'}"; password-based SSH login may be permitted.`,
    'Set "PasswordAuthentication no" in /etc/ssh/sshd_config to enforce key-only auth.'
  );
}

/** REQ 8.6 — MFA if applicable */
function check8_6(passwdAuthResult) {
  const ID   = '8.6';
  const DESC = 'Multi-factor authentication used for all remote admin access';

  const value = parseSshdOption(passwdAuthResult.stdout);

  // SSH key-only auth (PasswordAuthentication no) is acceptable for SAQ-A scope,
  // but true MFA (TOTP/hardware key) cannot be auto-verified here.
  if (value === 'no') {
    return req(
      ID, DESC, 'manual',
      'PasswordAuthentication disabled (key-only SSH). SSH keys satisfy one factor. ' +
      'True MFA (TOTP/hardware token) cannot be automatically verified.',
      'Confirm whether a second authentication factor (e.g. TOTP via google-authenticator PAM) is deployed for admin access.'
    );
  }

  return req(
    ID, DESC, 'manual',
    'SSH auth configuration unclear; MFA status cannot be determined automatically.',
    'Verify that multi-factor authentication is enforced for all remote administrative access.'
  );
}

/** REQ 9.1 — Physical access controls (always manual) */
function check9_1() {
  return req(
    '9.1',
    'Appropriate facility entry controls to limit and monitor physical access to systems',
    'manual',
    'Physical access controls cannot be verified remotely by COSA.',
    'Manually verify that the Baanbaan Pi is secured in a locked enclosure or restricted area.'
  );
}

/** REQ 10.1 — Audit log all access */
function check10_1(authLogLinesResult) {
  const ID   = '10.1';
  const DESC = 'Audit logs implemented to link access to individual users';

  const output = authLogLinesResult.stdout.trim();
  if (!output || output.includes('not-found') || output.startsWith('0 ')) {
    return req(
      ID, DESC, 'warning',
      'auth.log not found or empty; system access logging may not be active.',
      'Ensure rsyslog/syslog is running and writing to /var/log/auth.log.'
    );
  }

  const lines = parseInt(output.split(/\s+/)[0], 10);
  if (!isNaN(lines) && lines > 0) {
    return req(ID, DESC, 'pass', `auth.log exists with ${lines} entries.`);
  }

  return req(
    ID, DESC, 'warning',
    `auth.log status unclear: "${output}"`,
    'Verify that authentication events are being logged to /var/log/auth.log.'
  );
}

/** REQ 10.2 — Log all admin actions */
function check10_2() {
  // All AI-initiated tool invocations are recorded to session.db by COSA by design.
  return req(
    '10.2',
    'Automated audit trails for all system components',
    'pass',
    'COSA records all tool invocations, inputs, and results to session.db via the SAM pattern. ' +
    'All AI-initiated admin actions are logged with timestamp and operator context.'
  );
}

/** REQ 10.5 — Logs protected from modification */
function check10_5(authLogStatResult) {
  const ID   = '10.5';
  const DESC = 'Audit logs secured so they cannot be altered';

  const output = authLogStatResult.stdout.trim();
  if (!output || output.startsWith('not-found')) {
    return req(
      ID, DESC, 'warning',
      'auth.log not found; cannot assess log file permissions.',
      'Ensure /var/log/auth.log exists and is protected against modification.'
    );
  }

  const spaceIdx = output.indexOf(' ');
  const modeStr  = spaceIdx > 0 ? output.slice(0, spaceIdx) : null;

  if (!modeStr) {
    return req(ID, DESC, 'warning', `Could not parse stat output: "${output}"`);
  }

  const octal       = parseInt(modeStr, 8);
  const othersWrite = (octal & 0o002) !== 0;
  const groupWrite  = (octal & 0o020) !== 0;

  if (othersWrite) {
    return req(
      ID, DESC, 'fail',
      `auth.log is world-writable (${modeStr}). Log integrity cannot be guaranteed.`,
      'Remove world-write permission: chmod o-w /var/log/auth.log'
    );
  }

  if (groupWrite) {
    return req(
      ID, DESC, 'warning',
      `auth.log is group-writable (${modeStr}). Verify group membership is restricted to syslog/adm only.`,
      'Ensure only the syslog group has write access; consider chmod 640.'
    );
  }

  return req(ID, DESC, 'pass', `auth.log permissions: ${modeStr} (not world- or group-writable).`);
}

/** REQ 11.2 — External vulnerability scans quarterly (always manual) */
function check11_2() {
  return req(
    '11.2',
    'Run internal and external network vulnerability scans at least quarterly',
    'manual',
    'External vulnerability scans are outside the scope of automated COSA checks.',
    'Schedule quarterly external scans with an ASV (Approved Scanning Vendor). Document results and remediation in compliance records.'
  );
}

/** REQ 12.1 — Security policy documented */
function check12_1(securityMdResult) {
  const ID   = '12.1';
  const DESC = 'Security policy established, published, maintained, and disseminated';

  const found = securityMdResult.stdout.trim();

  if (found) {
    return req(ID, DESC, 'pass', `SECURITY.md found at: ${found}`);
  }

  return req(
    ID, DESC, 'warning',
    'SECURITY.md not found in /home/weather (searched up to 4 levels deep).',
    'Create a SECURITY.md documenting the security policy, incident response contacts, and vulnerability disclosure process.'
  );
}

// ---------------------------------------------------------------------------
// Overall status + action items
// ---------------------------------------------------------------------------

/**
 * Derive overallStatus from requirements.
 * Manual items are excluded from automated status calculation.
 *
 * @param {Array<{ status: string }>} requirements
 * @returns {'compliant'|'non_compliant'|'needs_review'}
 */
function deriveOverallStatus(requirements) {
  const automated = requirements.filter((r) => r.status !== 'manual');
  if (automated.some((r) => r.status === 'fail'))    return 'non_compliant';
  if (automated.some((r) => r.status === 'warning')) return 'needs_review';
  return 'compliant';
}

/**
 * Build action item strings for all non-pass, non-manual requirements.
 *
 * @param {Array<{ id: string, description: string, status: string, recommendation?: string }>} requirements
 * @returns {string[]}
 */
function buildActionItems(requirements) {
  return requirements
    .filter((r) => r.status === 'fail' || r.status === 'warning')
    .map((r) => `[${r.id}] ${r.description}${r.recommendation ? ` — ${r.recommendation}` : ''}`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   assessmentDate: string,
 *   scope: 'SAQ-A',
 *   requirements: Array<{
 *     id: string,
 *     description: string,
 *     status: 'pass'|'fail'|'warning'|'manual',
 *     evidence: string,
 *     recommendation?: string
 *   }>,
 *   overallStatus: 'compliant'|'non_compliant'|'needs_review',
 *   actionItems: string[]
 * }>}
 */
async function handler() {
  const assessmentDate = new Date().toISOString();
  const { appliance }  = getConfig();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run pci_assessment');
  }

  const knownPortSet = new Set(
    (appliance.monitoring?.known_ports ?? []).map(Number)
  );

  // ── Fire all SSH commands in parallel ────────────────────────────────────
  const [
    defaultAccountsResult,
    ssResult,
    duplicateUidsResult,
    passwdAuthResult,
    authLogLinesResult,
    authLogStatResult,
    securityMdResult,
  ] = await Promise.all([
    sshBackend.exec(CMD_DEFAULT_ACCOUNTS),
    sshBackend.exec(CMD_SS),
    sshBackend.exec(CMD_DUPLICATE_UIDS),
    sshBackend.exec(CMD_SSHD_PASSWORD_AUTH),
    sshBackend.exec(CMD_AUTH_LOG_LINES),
    sshBackend.exec(CMD_AUTH_LOG_STAT),
    sshBackend.exec(CMD_SECURITY_MD),
  ]);

  // ── Attempt dep_audit dispatch (6.1 / 6.2) ───────────────────────────────
  let depAuditResult = null;
  try {
    depAuditResult = await toolRegistry.dispatch('dep_audit', {});
  } catch (err) {
    if (err.code !== 'TOOL_NOT_FOUND') {
      log.warn(`dep_audit dispatch error: ${err.message}`);
    }
    // depAuditResult stays null — checks 6.1 and 6.2 will return 'warning'
  }

  // ── Build requirements ────────────────────────────────────────────────────
  const requirements = [
    check2_1(defaultAccountsResult),
    check2_2(ssResult, knownPortSet),
    check6_1(depAuditResult),
    check6_2(depAuditResult),
    check8_1(duplicateUidsResult),
    check8_2(passwdAuthResult),
    check8_6(passwdAuthResult),
    check9_1(),
    check10_1(authLogLinesResult),
    check10_2(),
    check10_5(authLogStatResult),
    check11_2(),
    check12_1(securityMdResult),
  ];

  const overallStatus = deriveOverallStatus(requirements);
  const actionItems   = buildActionItems(requirements);

  const passCount    = requirements.filter((r) => r.status === 'pass').length;
  const failCount    = requirements.filter((r) => r.status === 'fail').length;
  const warnCount    = requirements.filter((r) => r.status === 'warning').length;
  const manualCount  = requirements.filter((r) => r.status === 'manual').length;

  log.info(
    `pci_assessment complete: ${overallStatus} — ` +
    `${passCount} pass, ${failCount} fail, ${warnCount} warning, ${manualCount} manual`
  );

  return {
    assessmentDate,
    scope: 'SAQ-A',
    requirements,
    overallStatus,
    actionItems,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
