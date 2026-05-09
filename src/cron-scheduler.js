'use strict';

const fs     = require('fs');
const path   = require('path');

// ---------------------------------------------------------------------------
// Security constants
// ---------------------------------------------------------------------------

/** Allowed characters in a systemd service name (mirrors restart-appliance.js). */
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_\-.@]+$/;

/** Valid .env key: starts with letter or underscore, followed by alphanumeric/underscore. */
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Escape a string for use inside a shell single-quoted argument.
 * The only character that can break a single-quote context is `'` itself,
 * which is replaced by `'\''` (end quote, escaped single-quote, reopen quote).
 */
function shellSingleQuote(str) {
  return str.replace(/'/g, "'\\''");
}

const cron = require('node-cron');
const { getConfig }    = require('../config/cosa.config');
const orchestrator     = require('./orchestrator');
const emailGateway     = require('./email-gateway');
const sshBackend       = require('./ssh-backend');
const { createAlert, findRecentAlert, findLastAlertByCategory, getLastToolOutput } = require('./session-store');
const { createLogger } = require('./logger');
const healthCheckTool        = require('./tools/health-check');
const internetIpCheckTool    = require('./tools/internet-ip-check');
const credentialAuditTool    = require('./tools/credential-audit');
const ipsAlertTool           = require('./tools/ips-alert');
const backupVerifyTool       = require('./tools/backup-verify');
const gitAuditTool           = require('./tools/git-audit');
const backupRunTool          = require('./tools/backup-run');
const processMonitorTool     = require('./tools/process-monitor');
const networkScanTool        = require('./tools/network-scan');
const accessLogScanTool      = require('./tools/access-log-scan');
const shiftReportTool                = require('./tools/shift-report');
const resourceThresholdMonitorTool   = require('./tools/resource-threshold-monitor');
const autoPatchTool                  = require('./tools/auto-patch');

const log = createLogger('cron-scheduler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard timeout for any single cron-triggered orchestrator session.
 * Prevents a hung tool call or approval wait from blocking the cron worker
 * indefinitely and starving subsequent scheduled tasks.
 */
const CRON_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Suppress a repeat alert for the same category + severity within this window. */
const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Suppress a second shift report within this window (6 hours). */
const SHIFT_REPORT_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Suppress a second archive-check alert within 23h (cron fires once a day). */
const ARCHIVE_CHECK_DEDUP_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Suppress a second weekly digest if one was sent within the past 6 days. */
const DIGEST_DEDUP_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Suppress a second monthly report within 25 days. */
const MONTHLY_DEDUP_WINDOW_MS = 25 * 24 * 60 * 60 * 1000;

/** Category tags stored in the alerts table. */
const INTERNET_IP_WATCH_CATEGORY  = 'internet_ip_watch';
const HEALTH_CHECK_CATEGORY       = 'health_check';
const BACKUP_RUN_CATEGORY         = 'backup-run';
const BACKUP_VERIFY_CATEGORY      = 'backup-verify';
const ARCHIVE_CHECK_CATEGORY      = 'archive_check';
const SHIFT_REPORT_CATEGORY       = 'shift_report';
const DIGEST_CATEGORY             = 'digest';

// Phase 3 categories
const GIT_AUDIT_CATEGORY          = 'git_audit';
const PROCESS_MONITOR_CATEGORY    = 'process_monitor';
const NETWORK_SCAN_CATEGORY       = 'network_scan';
const ACCESS_LOG_CATEGORY         = 'access_log_scan';
const SEC_DIGEST_CATEGORY         = 'security_digest';
const CREDENTIAL_AUDIT_CATEGORY   = 'credential_audit';
const COMPLIANCE_VERIFY_CATEGORY  = 'compliance_verify';
const WEBHOOK_HMAC_CATEGORY       = 'webhook_hmac_verify';
const JWT_SECRET_CATEGORY         = 'jwt_secret_check';
const PCI_ASSESSMENT_CATEGORY     = 'pci_assessment';
const TOKEN_ROTATION_CATEGORY     = 'token_rotation_remind';
const TUNNEL_HEALTH_CATEGORY      = 'tunnel_health_check';
const AUTO_PATCH_COSA_CATEGORY      = 'auto_patch_cosa';
const AUTO_PATCH_APPLIANCE_CATEGORY = 'auto_patch_appliance';
const RESOURCE_THRESHOLD_CATEGORY = 'resource_threshold_monitor';

const TUNNEL_HEALTH_DEDUP_WINDOW_MS    = 65 * 60 * 1000;
const INTERNET_IP_WATCH_DEDUP_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an orchestrator session with a hard timeout.
 * If the session does not complete within CRON_SESSION_TIMEOUT_MS, the returned
 * promise rejects so the cron task can log and move on rather than hanging.
 *
 * @param {{ type: string, source: string, message: string }} trigger
 * @returns {Promise<{ session_id: string }>}
 */
function runSessionWithTimeout(trigger) {
  return Promise.race([
    orchestrator.runSession(trigger),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Cron session timed out after ${CRON_SESSION_TIMEOUT_MS / 1000}s (source: ${trigger.source})`)),
        CRON_SESSION_TIMEOUT_MS
      )
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Trigger builders
// ---------------------------------------------------------------------------

/** @returns {{ type: string, source: string, message: string }} */
function buildHealthCheckTrigger() {
  return {
    type:    'cron',
    source:  'health-check',
    message: `You are running the scheduled hourly health check for Baanbaan.

Run the health_check tool to assess the appliance state. If the result is healthy, respond with a brief summary and take no further action. If degraded or unreachable, diagnose using db_integrity if needed, then respond with your findings and recommendations — the system will alert the operator automatically.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildBackupTrigger() {
  return {
    type:    'cron',
    source:  'backup',
    message: `Scheduled nightly backup. Run backup_run to create a backup of the appliance database. If successful, run backup_verify to confirm the checksum. Update MEMORY.md with the backup status. If backup fails, respond with the failure details — the system will alert the operator automatically.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildBackupVerifyTrigger() {
  return {
    type:    'cron',
    source:  'backup-verify',
    message: `Verify the most recent appliance backup. Run backup_verify and report. If checksum mismatch or file missing, respond with the failure details — the system will alert the operator automatically.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildArchiveCheckTrigger() {
  return {
    type:    'cron',
    source:  'archive-check',
    message: `Archive integrity check. Run session_search for any backup failure or anomaly mentions in the last 7 days. If a recurring pattern is found, summarise it in your response — the system will alert the operator automatically.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildShiftReportTrigger() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    type:    'cron',
    source:  'shift-report',
    message: `Generate the daily shift report for the past 24 hours. Run shift_report to gather the data, then write the complete plain-text report as your response.

IMPORTANT: Your response IS the email body — it will be sent to the operator automatically. Write only the report content. Do not include any preamble, meta-commentary about sending, or instructions to the operator. Start directly with the report header.

The email subject will be: [COSA] Shift Report: ${today}
Plain text only — no HTML, no markdown.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildWeeklyDigestTrigger() {
  // Monday = start of the week; use the Monday date as the "week of" date.
  const weekOf = _getMondayDateString();
  return {
    type:    'cron',
    source:  'weekly-digest',
    message: `Generate the weekly operational digest. Gather data as follows:
1. Run session_search with query "backup success failure" to summarise backup status for the past 7 days.
2. Run session_search with query "health degraded unreachable alert" to summarise health check results for the past 7 days.
3. Query the skills database via session_search for skills created or improved this week.
4. Count operator-initiated sessions and approval requests from the past 7 days.

Then write the complete digest as your response using this exact structure:
- Header: appliance name and "Weekly Operational Digest"
- Week range: week of ${weekOf}
- Section: HEALTH CHECK (N runs, healthy/failed counts, incidents)
- Section: BACKUPS (N runs, successful/failed counts, most recent backup date)
- Section: ANOMALIES THIS WEEK
- Section: SKILLS (new skills created, skills improved)
- Section: OPERATOR ACTIVITY (sessions, approval requests)
- Footer: "— COSA"

IMPORTANT: Your response IS the email body — it will be sent to the operator automatically. Write only the digest content. Do not include any preamble, meta-commentary about sending, or instructions to the operator. Start directly with the digest header.

The email subject will be: [COSA] Weekly Digest: week of ${weekOf}
Plain text only — no HTML, no markdown.

Current time: ${new Date().toISOString()}`,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 trigger builders
// ---------------------------------------------------------------------------

/** @returns {{ type: string, source: string, message: string }} */
function buildGitAuditTrigger() {
  return {
    type:    'cron',
    source:  'git-audit',
    message: `Scheduled git audit. Run git_audit to inspect the appliance git repositories for uncommitted changes, untracked files, and suspicious commits.

If any finding has severity "medium", "high", or "critical", immediately run ips_alert with the finding details to notify the operator.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildProcessMonitorTrigger() {
  return {
    type:    'cron',
    source:  'process-monitor',
    message: `Scheduled process monitor check. Run process_monitor to inspect running processes on the appliance for unexpected binaries, privilege escalation, or suspicious activity.

If any finding has severity "medium", "high", or "critical", immediately run ips_alert with the finding details to trigger the security escalation response.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildNetworkScanTrigger() {
  return {
    type:    'cron',
    source:  'network-scan',
    message: `Scheduled network scan. Run network_scan to enumerate devices and open ports on the appliance network.

If any unknown or unexpected device is found (not in the known_devices list), immediately run ips_alert with the device details.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildAccessLogScanTrigger() {
  return {
    type:    'cron',
    source:  'access-log-scan',
    message: `Scheduled access log scan. Run access_log_scan to parse the appliance web server and SSH access logs for anomalies (brute force, unusual IPs, path traversal attempts, etc.).

Feed the results to the anomaly classifier for threat scoring. If any anomaly has a threat score or severity of "medium" or above, run ips_alert with the anomaly details.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildWeeklySecurityDigestTrigger() {
  const weekOf = _getMondayDateString();
  const { appliance } = getConfig();
  const accessLogEnabled = appliance.tools?.access_log_scan?.enabled !== false;

  const nextScanDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextPciDate  = (() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const accessLogStep = accessLogEnabled
    ? '4. Run session_search with query "access_log anomaly threat brute" for the past 7 days.'
    : '4. Skip — access log scanning is disabled for this appliance (no public web frontend; SSH is key-only). Do not run session_search for access_log.';

  const accessLogSection = accessLogEnabled
    ? '- Section: ACCESS LOG ANOMALIES — mark ✓ if none, or ⚠ with count and top threat categories'
    : '- Section: ACCESS LOG ANOMALIES — render exactly: "N/A — appliance is LAN-only with key-only SSH; no web frontend"';

  return {
    type:    'cron',
    source:  'security-digest',
    message: `Generate the weekly security digest. Gather data as follows:
1. Run session_search with query "git_audit severity medium high critical" for the past 7 days.
2. Run session_search with query "process_monitor unexpected missing" for the past 7 days.
3. Run session_search with query "network_scan unknown device" for the past 7 days.
${accessLogStep}
5. Run compliance_verify to get the current compliance posture.
6. Run credential_audit to check for exposed credentials in the repository.
7. Run jwt_secret_check to get the current JWT entropy level and last-rotated date.
8. Run session_search with query "webhook_hmac jwt_secret" for the past 7 days.
9. Count total security alert sessions from the past 7 days for the incident count.

Then write the complete digest as your response with this exact structure:
- Header: appliance name, "Weekly Security Digest — week of ${weekOf}"
- Section: GIT AUDIT — mark ✓ if no findings, or ⚠ with findings count and highest severity
- Section: PROCESS MONITOR — mark ✓ if all expected processes running, or ⚠ with unexpected/missing process names
- Section: NETWORK — mark ✓ if all devices known, or ⚠ with unknown device count and MAC addresses
${accessLogSection}
- Section: COMPLIANCE — SAQ-A overall status (from compliance_verify); include JWT entropy level, last-rotated date, and next rotation date (from jwt_secret_check)
- Section: CREDENTIALS — mark ✓ if no findings, or ⚠ with credential_audit summary; note .gitignore coverage
- Line: SECURITY INCIDENTS THIS WEEK: N
- Footer: Next scan: ${nextScanDate} | Next PCI assessment: ${nextPciDate}
- Footer: "— COSA Security Monitor"

Use ✓ to indicate a clean result and ⚠ followed by specific details for any anomaly or finding.

IMPORTANT: Your response IS the email body — it will be sent to the operator automatically. Write only the digest content. Do not include any preamble, meta-commentary about sending, or instructions to the operator. Start directly with the digest header.

Retrieve the appliance name from the config and use it in the subject.
The email subject will be: [COSA] Weekly Security Digest — <appliance name> — ${weekOf}
Plain text only — no HTML, no markdown.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildComplianceVerifyTrigger() {
  return {
    type:    'cron',
    source:  'compliance-verify',
    message: `Scheduled compliance verification. Run compliance_verify to assess the current PCI-DSS and security compliance posture.

Log the result. If any control is failing (status: "non_compliant"), include that in your response as "COMPLIANCE FAIL:" followed by the failing controls. This result will be included in the weekly security digest.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildWebhookHmacTrigger() {
  return {
    type:    'cron',
    source:  'webhook-hmac-verify',
    message: `Scheduled webhook HMAC verification. Run webhook_hmac_verify to confirm that all webhook endpoints are protected with valid HMAC signatures.

If any webhook endpoint has HMAC inactive, missing, or invalid, immediately run ips_alert with severity "critical" and details of the unprotected endpoint.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildJwtSecretCheckTrigger() {
  return {
    type:    'cron',
    source:  'jwt-secret-check',
    message: `Scheduled JWT secret rotation check. Run jwt_secret_check to verify the age and rotation schedule of all JWT signing secrets.

If any secret is due for rotation (or overdue), run ips_alert with a rotation reminder. Include the secret identifier (not the value) and the days until/since rotation was due.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildPciAssessmentTrigger() {
  const monthOf = new Date().toISOString().slice(0, 7);
  return {
    type:    'cron',
    source:  'pci-assessment',
    message: `Monthly PCI-DSS self-assessment. Run pci_assessment to generate a full SAQ-A assessment report.

Write the complete assessment as your response, covering all 13 SAQ-A requirements.

IMPORTANT: Your response IS the email body — it will be sent to the operator automatically. Write only the assessment content. Do not include any preamble, meta-commentary about sending, or instructions to the operator. Start directly with the assessment header.

The email subject will be: [COSA] Monthly PCI Assessment: ${monthOf}
Plain text only — no HTML, no markdown.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildTokenRotationRemindTrigger() {
  return {
    type:    'cron',
    source:  'token-rotation-remind',
    message: `Monthly token rotation reminder. Run token_rotation_remind to check all API tokens and service credentials for upcoming rotation deadlines.

Write your response listing any tokens approaching or past their rotation deadline. Include token name (not value), days until deadline, and recommended action.

IMPORTANT: Your response IS the email body — it will be sent to the operator automatically only if tokens are due. Write only the reminder content. Do not include any preamble or meta-commentary about sending.

Current time: ${new Date().toISOString()}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the ISO date string (YYYY-MM-DD) of the most recent Monday
 * at or before today.
 * @returns {string}
 */
function _getMondayDateString() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, …
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Compose a plain-text alert email body from a health-check result.
 * @param {object} result
 * @returns {string}
 */
function buildAlertBody(result) {
  const lines = [
    'COSA automated health check detected an issue:',
    '',
    `Status:       ${(result.overall_status ?? 'UNKNOWN').toUpperCase()}`,
    `Checked at:   ${result.checked_at ?? new Date().toISOString()}`,
    '',
    `SSH Connected:  ${result.ssh_connected}`,
    `HTTP Health:    ${result.http_health?.reachable
      ? `reachable (${result.http_health.status_code})`
      : 'unreachable'}`,
    `HTTP Ready:     ${result.http_ready?.reachable
      ? `reachable (${result.http_ready.status_code})`
      : 'unreachable'}`,
  ];

  if (result.process) {
    lines.push(
      `Process:        ${result.process.running ? 'running' : 'not running'} (${result.process.active_state})`
    );
    if (result.process.restarts > 0) {
      lines.push(`Restarts:       ${result.process.restarts}`);
    }
  }

  if (result.errors && result.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const e of result.errors) lines.push(`  - ${e}`);
  }

  lines.push('', '--- Automated alert from COSA ---');
  return lines.join('\n');
}

/**
 * Compose a plain-text recovery email body when the appliance returns to healthy.
 * @param {object} result
 * @returns {string}
 */
function buildRecoveryBody(result) {
  const lines = [
    'COSA automated health check: issue resolved.',
    '',
    `Status:       HEALTHY`,
    `Checked at:   ${result.checked_at ?? new Date().toISOString()}`,
    '',
    `SSH Connected:  ${result.ssh_connected}`,
    `HTTP Health:    ${result.http_health?.reachable
      ? `reachable (${result.http_health.status_code})`
      : 'unreachable'}`,
    `HTTP Ready:     ${result.http_ready?.reachable
      ? `reachable (${result.http_ready.status_code})`
      : 'unreachable'}`,
  ];

  if (result.process) {
    lines.push(
      `Process:        ${result.process.running ? 'running' : 'not running'} (${result.process.active_state})`
    );
  }

  lines.push('', '--- Automated alert from COSA ---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internet IP watch — state helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {{ lastKnownIp: string|null, internetWasDown: boolean, lastCheckedAt: string, lastChangedAt: string|null }} IpState
 */

/** @returns {string} */
function _ipStateFilePath() {
  // Use the same resolution as session-store (path.resolve) so the path is
  // absolute and stable regardless of working directory at call time.
  const { env } = getConfig();
  return path.resolve(env.dataDir, 'ip-state.json');
}

/**
 * Read persisted IP state from disk.  Returns defaults when the file is absent.
 * @returns {IpState}
 */
function _readIpState() {
  try {
    const raw = fs.readFileSync(_ipStateFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastKnownIp: null, internetWasDown: false, lastCheckedAt: null, lastChangedAt: null };
  }
}

/**
 * Persist IP state to disk (synchronous — small JSON, no race risk at 2-min interval).
 * Creates the data directory if it does not exist.
 * @param {IpState} state
 */
function _writeIpState(state) {
  const filePath = _ipStateFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Validate that a string is a dotted-decimal IPv4 address.
 * Prevents shell injection when the value is embedded in a sed command.
 * @param {string|null} ip
 * @returns {boolean}
 */
function _isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

/**
 * Update a single key in the remote .env file.
 *
 * Handles two value shapes:
 *  - Scalar  ("KEY=x.x.x.x")         → replace the whole value with newIp.
 *  - List    ("KEY=a,b,c,...")        → replace oldIp in the list; if oldIp is
 *                                       absent (first run), prepend newIp instead.
 *
 * Only executes when the key is already present in the file (safe no-op otherwise).
 *
 * @param {string}      envFilePath - Absolute path on the remote appliance.
 * @param {string}      key         - .env key (e.g. 'ALLOWED_MERCHANT_IPS').
 * @param {string|null} oldIp       - Previously known IP (null on first run).
 * @param {string}      newIp       - Already-validated IPv4 address.
 * @returns {Promise<{ updated: boolean, error: string|null }>}
 */
async function _updateEnvKey(envFilePath, key, oldIp, newIp) {
  // Reject keys that could inject shell metacharacters into the remote commands.
  if (!SAFE_ENV_KEY.test(key)) {
    return { updated: false, error: `Unsafe .env key rejected: ${key}` };
  }
  // Escape single-quotes in the path so it is safe in single-quoted shell arguments.
  const safePath = shellSingleQuote(envFilePath);

  // grep exits 0 when the key exists; 1 when absent.
  const existsResult = await sshBackend.exec(`grep -q '^${key}=' '${safePath}'`);
  if (existsResult.exitCode !== 0) {
    return { updated: false, error: `Key ${key} not found in ${envFilePath}` };
  }

  // Read current value so we can handle comma-separated lists correctly.
  const readResult = await sshBackend.exec(`grep '^${key}=' '${safePath}'`);
  if (readResult.exitCode !== 0) {
    return { updated: false, error: `Failed to read ${key} from ${envFilePath}` };
  }

  const currentLine  = readResult.stdout.trim();
  const eqIdx        = currentLine.indexOf('=');
  const currentValue = eqIdx >= 0 ? currentLine.slice(eqIdx + 1) : '';
  const isList       = currentValue.includes(',');

  let newValue;
  if (isList) {
    const parts = currentValue.split(',').map(s => s.trim());
    if (oldIp && parts.includes(oldIp)) {
      // Replace old IP in place — preserves position and all other entries.
      newValue = parts.map(p => (p === oldIp ? newIp : p)).join(',');
    } else if (parts.includes(newIp)) {
      // Already present — nothing to do.
      return { updated: false, error: null };
    } else {
      // Old IP not in list (first run) — prepend new IP.
      newValue = [newIp, ...parts].join(',');
    }
  } else {
    // Scalar: replace the whole value.
    newValue = newIp;
  }

  // Escape characters that have special meaning as a sed | delimiter or
  // in the replacement side (& means "matched text" in sed).
  const escapedValue = newValue.replace(/[|\\&]/g, '\\$&');
  const sedCmd       = `sed -i 's|^${key}=.*|${key}=${escapedValue}|' '${safePath}'`;
  const sedResult    = await sshBackend.exec(sedCmd);
  if (sedResult.exitCode !== 0) {
    return { updated: false, error: `sed failed (exit ${sedResult.exitCode}): ${sedResult.stderr.trim()}` };
  }

  return { updated: true, error: null };
}

/**
 * Build the plain-text alert email body for a public-IP change event.
 *
 * @param {{ applianceName: string, oldIp: string|null, newIp: string, wasDown: boolean, updatedKeys: string[], restartedServices: string[], errors: string[] }} params
 * @returns {string}
 */
function buildIpChangeAlertBody({ applianceName, oldIp, newIp, wasDown, updatedKeys, restartedServices, errors }) {
  const eventDescription = wasDown
    ? 'Internet connectivity was restored after an outage.'
    : 'The public IP address changed unexpectedly.';

  const lines = [
    `COSA detected a public IP change on ${applianceName}:`,
    '',
    eventDescription,
    '',
    `Previous IP:  ${oldIp ?? '(unknown — first run)'}`,
    `New IP:       ${newIp}`,
    '',
  ];

  if (updatedKeys.length > 0) {
    lines.push(`Updated .env keys: ${updatedKeys.join(', ')}`);
  } else {
    lines.push('No .env keys were updated (none matched the watched_keys list).');
  }

  if (restartedServices.length === 0) {
    lines.push('Services restarted: none (disabled or skipped)');
  } else {
    lines.push(`Services restarted: ${restartedServices.join(', ')}`);
  }

  if (errors.length > 0) {
    lines.push('', 'Errors:');
    for (const e of errors) lines.push(`  - ${e}`);
  }

  lines.push('', '--- Automated alert from COSA ---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internet IP watch task
// ---------------------------------------------------------------------------

/**
 * Poll the public IP every 2 minutes.
 *
 * - Internet down  → mark state, log, return (no alert spam while down).
 * - Recovery or IP change → update watched .env keys via SSH, optionally
 *   restart the appliance service, email the operator.
 *
 * @returns {Promise<void>}
 */
async function runInternetIpWatchTask() {
  const { appliance } = getConfig();
  const watchConfig   = appliance.tools?.internet_ip_watch ?? {};

  if (watchConfig.enabled === false) return;

  const operatorEmail    = appliance.operator.email;
  const applianceName    = appliance.name ?? 'Appliance';
  const envFilePath      = watchConfig.env_file_path ?? null;
  const watchedKeys      = watchConfig.watched_keys ?? [];
  const restartOnChange  = watchConfig.restart_service_on_change !== false;
  const serviceNames     = watchConfig.service_names ?? ['baanbaan'];

  // ── 1. Check current public IP ────────────────────────────────────────────
  let checkResult;
  try {
    checkResult = await internetIpCheckTool.handler();
  } catch (err) {
    log.error(`[internet-ip-watch] IP check threw: ${err.message}`);
    return;
  }

  const state = _readIpState();

  // ── 2. Internet is down ───────────────────────────────────────────────────
  if (!checkResult.internetUp) {
    if (!state.internetWasDown) {
      log.warn('[internet-ip-watch] Internet appears to be down — will recover automatically');
    }
    _writeIpState({ ...state, internetWasDown: true, lastCheckedAt: checkResult.checkedAt });
    return;
  }

  const newIp = checkResult.publicIp;

  if (!_isValidIpv4(newIp)) {
    log.error(`[internet-ip-watch] Unexpected IP format from ipify: ${newIp}`);
    return;
  }

  const wasDown    = state.internetWasDown;
  const isFirstRun = state.lastKnownIp === null;
  const ipChanged  = !isFirstRun && state.lastKnownIp !== newIp;

  // ── 3. No change and not first run → update heartbeat and return ──────────
  if (!wasDown && !ipChanged && !isFirstRun) {
    // Always persist lastKnownIp so the next genuine change is detected.
    _writeIpState({ ...state, lastKnownIp: newIp, internetWasDown: false, lastCheckedAt: checkResult.checkedAt });
    log.info(`[internet-ip-watch] Public IP stable: ${newIp}`);
    return;
  }

  // ── 3b. First run — persist the IP silently, no alert needed ─────────────
  // This avoids a spurious alert every time COSA restarts.  A genuine IP
  // change (from a previously known value) still triggers the full alert path.
  if (isFirstRun && !wasDown) {
    _writeIpState({ lastKnownIp: newIp, internetWasDown: false, lastCheckedAt: checkResult.checkedAt, lastChangedAt: null });
    log.info(`[internet-ip-watch] First run — recorded public IP: ${newIp}`);
    return;
  }

  // ── 3c. Internet was down but came back with the same IP → no action ──────
  // T-Mobile cellular gateway briefly unreachable (e.g. during our scheduled
  // appliance reboot at 1am) and now back. The .env values are still correct;
  // re-running the env-update + service-restart sequence and emailing the
  // operator would just be noise. Silently clear the wasDown flag and return.
  if (wasDown && !ipChanged && !isFirstRun) {
    _writeIpState({ ...state, lastKnownIp: newIp, internetWasDown: false, lastCheckedAt: checkResult.checkedAt });
    log.info(`[internet-ip-watch] Internet recovered, public IP unchanged: ${newIp}`);
    return;
  }

  const changeReason = wasDown ? 'internet recovery' : 'IP change';
  log.info(`[internet-ip-watch] ${changeReason}: ${state.lastKnownIp ?? '(none)'} → ${newIp}`);

  // ── 4. Update .env keys via SSH ───────────────────────────────────────────
  const updatedKeys = [];
  const errors      = [];

  if (envFilePath && watchedKeys.length > 0) {
    if (!sshBackend.isConnected()) {
      errors.push('SSH not connected — .env keys not updated');
    } else {
      for (const key of watchedKeys) {
        try {
          const { updated, error } = await _updateEnvKey(envFilePath, key, state.lastKnownIp, newIp);
          if (updated) {
            updatedKeys.push(key);
            log.info(`[internet-ip-watch] Updated ${key} → ${newIp}`);
          } else {
            errors.push(error);
            log.warn(`[internet-ip-watch] ${error}`);
          }
        } catch (err) {
          errors.push(`${key}: ${err.message}`);
          log.error(`[internet-ip-watch] Failed to update ${key}: ${err.message}`);
        }
      }
    }
  }

  // ── 5. Restart services if any key was updated ────────────────────────────
  const restartedServices = [];
  if (updatedKeys.length > 0 && restartOnChange && sshBackend.isConnected()) {
    for (const name of serviceNames) {
      if (!SAFE_SERVICE_NAME.test(name)) {
        errors.push(`Skipped unsafe service name: ${name}`);
        log.error(`[internet-ip-watch] Rejected service name with shell metacharacters: ${name}`);
        continue;
      }
      try {
        const restartResult = await sshBackend.exec(`sudo systemctl restart ${name}`);
        if (restartResult.exitCode === 0) {
          restartedServices.push(name);
          log.info(`[internet-ip-watch] Service ${name} restarted`);
        } else {
          errors.push(`systemctl restart ${name} failed (exit ${restartResult.exitCode})`);
          log.error(`[internet-ip-watch] Service ${name} restart failed: ${restartResult.stderr.trim()}`);
        }
      } catch (err) {
        errors.push(`Service restart ${name}: ${err.message}`);
        log.error(`[internet-ip-watch] Service ${name} restart threw: ${err.message}`);
      }
    }
  }

  // ── 6. Persist new state ──────────────────────────────────────────────────
  _writeIpState({
    lastKnownIp:     newIp,
    internetWasDown: false,
    lastCheckedAt:   checkResult.checkedAt,
    lastChangedAt:   checkResult.checkedAt,
  });

  // ── 7. Alert operator ─────────────────────────────────────────────────────
  const ipAlertSinceIso = new Date(Date.now() - INTERNET_IP_WATCH_DEDUP_WINDOW_MS).toISOString();
  const recentIpAlert   = findRecentAlert(INTERNET_IP_WATCH_CATEGORY, 'info', ipAlertSinceIso)
                       ?? findRecentAlert(INTERNET_IP_WATCH_CATEGORY, 'warning', ipAlertSinceIso);
  if (recentIpAlert) {
    log.info(`[internet-ip-watch] Suppressed duplicate IP-change alert (last sent: ${recentIpAlert.sent_at})`);
    return;
  }

  const title = wasDown
    ? `${applianceName} — Internet restored, public IP updated to ${newIp}`
    : `${applianceName} — Public IP changed to ${newIp}`;

  const body    = buildIpChangeAlertBody({
    applianceName,
    oldIp: state.lastKnownIp,
    newIp,
    wasDown,
    updatedKeys,
    restartedServices,
    errors,
  });
  const sentAt  = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: null,
    severity:   errors.length > 0 ? 'warning' : 'info',
    category:   INTERNET_IP_WATCH_CATEGORY,
    title,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`[internet-ip-watch] Alert sent: ${title}`);
}

// ---------------------------------------------------------------------------
// Core cron tasks
// ---------------------------------------------------------------------------

/**
 * Execute a health check and alert the operator if the appliance is not healthy.
 *
 * Calls the health_check tool handler directly — no Claude API call needed.
 * The tool result alone determines status, and buildAlertBody() formats the
 * email body without LLM involvement.
 *
 * healthy      → log and return (0 API calls)
 * degraded     → send 'warning' alert email (dedup 60 min)
 * unreachable  → send 'critical' alert email (dedup 60 min)
 *
 * @returns {Promise<void>}
 */
async function runHealthCheckTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  // ── 1. Run health_check tool directly (no Claude session) ─────────────────
  let healthResult;
  try {
    healthResult = await healthCheckTool.handler();
  } catch (err) {
    log.error(`Health check tool threw unexpectedly: ${err.message}`);
    healthResult = { overall_status: 'unreachable', error: err.message };
  }

  const overall_status = healthResult.overall_status ?? 'unreachable';
  log.info(`Health check complete: ${overall_status}`);

  if (overall_status === 'healthy') {
    // ── Recovery notification: send once when transitioning from an alert ────
    const lastAlert = findLastAlertByCategory(HEALTH_CHECK_CATEGORY);
    if (lastAlert && lastAlert.severity !== 'resolved') {
      const applianceName = appliance.name ?? 'Appliance';
      const title  = `${applianceName} is HEALTHY`;
      const body   = buildRecoveryBody(healthResult);
      const sentAt = new Date().toISOString();

      await emailGateway.sendEmail({
        to:      operatorEmail,
        subject: `[COSA Resolved] ${title}`,
        text:    body,
      });

      createAlert({
        session_id: null,
        severity:   'resolved',
        category:   HEALTH_CHECK_CATEGORY,
        title,
        body,
        sent_at:    sentAt,
        email_to:   operatorEmail,
      });

      log.info(`Recovery alert sent: ${applianceName} back to healthy`);
    }
    return;
  }

  // ── 2. Dedup check ─────────────────────────────────────────────────────────
  const severity = overall_status === 'unreachable' ? 'critical' : 'warning';
  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(HEALTH_CHECK_CATEGORY, severity, sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate ${severity} alert (last sent: ${recent.sent_at})`);
    return;
  }

  // ── 3. Send alert email ────────────────────────────────────────────────────
  const applianceName = appliance.name ?? 'Appliance';
  const title  = overall_status === 'unreachable'
    ? `${applianceName} is UNREACHABLE`
    : `${applianceName} health is DEGRADED`;
  const body   = buildAlertBody(healthResult);
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: null, // no Claude session for health checks
    severity,
    category:   HEALTH_CHECK_CATEGORY,
    title,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Alert sent: ${severity} — ${title}`);
}

/**
 * Run the nightly backup task: backup_run → backup_verify.
 * Sends an alert email on failure.
 * @returns {Promise<void>}
 */
async function runBackupTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  let backupResult;
  try {
    backupResult = await backupRunTool.handler({});
  } catch (err) {
    log.error(`[backup] tool threw: ${err.message}`);
    backupResult = { success: false, error: err.message };
  }

  if (backupResult.success) {
    const files   = backupResult.backup_files ?? [];
    const skipped = backupResult.skipped_tables ?? [];
    const totalRows = files.reduce((n, f) => n + (f.row_count ?? 0), 0);
    const summary = files.map((f) => `${f.table}=${f.row_count ?? '?'}`).join(', ');
    log.info(
      `Backup complete: ${files.length} table(s), ${totalRows} rows total ` +
      `[${summary}]` +
      (skipped.length > 0 ? ` — skipped: ${skipped.join(', ')}` : '')
    );
    return;
  }

  // Failure path
  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(BACKUP_RUN_CATEGORY, 'critical', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate backup failure alert (last sent: ${recent.sent_at})`);
    return;
  }

  const applianceName = appliance.name ?? 'Appliance';
  const title  = `${applianceName} — Backup Failed`;
  const body   = [
    'COSA automated nightly backup failed:',
    '',
    `Error:      ${backupResult.error ?? 'unknown error'}`,
    `Started at: ${backupResult.started_at ?? new Date().toISOString()}`,
    '',
    'The previous successful backup may be used for recovery.',
    '',
    '--- Automated alert from COSA ---',
  ].join('\n');
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: null, // no Claude session for backup
    severity:   'critical',
    category:   BACKUP_RUN_CATEGORY,
    title,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Backup failure alert sent`);
}

/**
 * Verify the most recent backup.  Alerts on checksum mismatch or missing file.
 * @returns {Promise<void>}
 */
async function runBackupVerifyTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;
  const tables    = appliance.tools?.backup_run?.tables ?? [];
  const backupDir = appliance.tools?.backup_run?.backup_dir ?? '/tmp/cosa-backups';

  // 1. Probe the most-recent file to discover the batch timestamp. The verify
  //    tool's auto-discovery picks the freshest *.jsonl regardless of table.
  let probeResult;
  try {
    probeResult = await backupVerifyTool.handler({});
  } catch (err) {
    log.error(`[backup-verify] tool threw: ${err.message}`);
    probeResult = { verified: false, error: err.message };
  }

  // 2. Extract the batch timestamp (e.g. 2026-05-09T10-00-00-729Z) from
  //    "<dir>/<table>_<timestamp>.jsonl". If we cannot, fall back to
  //    single-file verification so the legacy alert path still fires.
  const tsMatch = (probeResult.backup_path ?? '').match(
    /_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/
  );

  /** @type {Array<{ table: string, verified: boolean, backup_path: string,
   *   expected_hash?: string|null, actual_hash?: string|null, error?: string }>} */
  const perTable = [];
  let verifyResult = probeResult;

  if (tsMatch && tables.length > 0) {
    const timestamp = tsMatch[1];
    for (const table of tables) {
      const filePath = `${backupDir}/${table}_${timestamp}.jsonl`;
      try {
        const r = await backupVerifyTool.handler({ backup_path: filePath });
        perTable.push({ table, verified: r.verified, backup_path: filePath,
          expected_hash: r.expected_hash, actual_hash: r.actual_hash });
      } catch (err) {
        perTable.push({ table, verified: false, backup_path: filePath,
          error: err.message });
      }
    }

    const failed = perTable.filter((r) => !r.verified);
    if (failed.length === 0) {
      log.info(`Backup verification passed: ${perTable.length} table(s) @ ${timestamp}`);
      return;
    }
    // Synthesize an alert payload that names the first failure for the
    // legacy single-file fields, while listing every failed table in body.
    verifyResult = {
      verified:      false,
      backup_path:   failed[0].backup_path,
      expected_hash: failed[0].expected_hash ?? null,
      actual_hash:   failed[0].actual_hash   ?? null,
      error:         failed[0].error,
      failed_tables: failed.map((r) => r.table),
    };
  } else if (probeResult.verified) {
    // No tables configured (or path unparseable), but the single probe passed.
    log.info(`Backup verification passed: ${probeResult.backup_path}`);
    return;
  }

  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(BACKUP_VERIFY_CATEGORY, 'critical', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate backup-verify alert`);
    return;
  }

  const applianceName = appliance.name ?? 'Appliance';
  const failedTables  = verifyResult.failed_tables ?? [];
  const title  = `${applianceName} — Backup Verification Failed`;
  const body   = [
    'COSA automated backup verification failed:',
    '',
    failedTables.length > 0
      ? `Failed tables: ${failedTables.join(', ')} (${failedTables.length} of ${perTable.length})`
      : `Backup path:    ${verifyResult.backup_path ?? 'unknown'}`,
    `First failure:  ${verifyResult.backup_path ?? 'unknown'}`,
    `Expected hash:  ${verifyResult.expected_hash ?? 'n/a'}`,
    `Actual hash:    ${verifyResult.actual_hash ?? 'n/a'}`,
    '',
    'The most recent backup may be corrupt. Do not use it for recovery without manual inspection.',
    '',
    '--- Automated alert from COSA ---',
  ].join('\n');
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: null, // no Claude session for backup_verify
    severity:   'critical',
    category:   BACKUP_VERIFY_CATEGORY,
    title,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Backup verification failure alert sent`);
}

/**
 * Run the archive integrity check: session_search for backup anomaly patterns.
 * If a recurring pattern is found, COSA sends an alert email; this function
 * adds a code-level deduplication guard (24 h) so the task cannot spam the
 * operator on consecutive nightly runs.
 * @returns {Promise<void>}
 */
async function runArchiveCheckTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  const dedupSinceIso = new Date(Date.now() - ARCHIVE_CHECK_DEDUP_WINDOW_MS).toISOString();
  const recent        = findRecentAlert(ARCHIVE_CHECK_CATEGORY, 'warning', dedupSinceIso);

  if (recent) {
    log.info(`Suppressed duplicate archive-check alert (last sent: ${recent.sent_at})`);
    return;
  }

  // Gate on a current-state signal: only fire if the backup pipeline has
  // produced a critical alert in the past 7 days.  This prevents archive_check
  // from re-surfacing historical session-store mentions of backup failures
  // that have since been fixed (e.g. the pre-7556e68 schema-mismatch bug).
  const lookbackIso         = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentBackupFailure = findRecentAlert(BACKUP_RUN_CATEGORY, 'critical', lookbackIso);

  if (!recentBackupFailure) {
    log.info('Archive check clean: no backup critical alerts in the past 7 days');
    return;
  }

  const trigger                    = buildArchiveCheckTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  // COSA is instructed to emit "ALERT:" when a recurring pattern is found.
  if (response && /ALERT:/i.test(response)) {
    const title  = 'Archive integrity anomaly detected';
    const sentAt = new Date().toISOString();

    await emailGateway.sendEmail({
      to:      operatorEmail,
      subject: `[COSA Alert] ${title}`,
      text:    response,
    });

    createAlert({
      session_id: sessionId,
      severity:   'warning',
      category:   ARCHIVE_CHECK_CATEGORY,
      title,
      body:       response,
      sent_at:    sentAt,
      email_to:   operatorEmail,
    });
  }

  log.info('Archive check complete');
}

/**
 * Generate and send the daily shift report email.
 *
 * Deduplication: no second email within SHIFT_REPORT_DEDUP_WINDOW_MS (6h).
 * Subject format: [COSA] Shift Report: YYYY-MM-DD
 * @returns {Promise<void>}
 */
function formatShiftReportBody(data) {
  const fmtTime  = iso => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'n/a');
  const fmtMoney = n   => `$${Number(n ?? 0).toFixed(2)}`;

  const orders    = data.orders  ?? {};
  const revenue   = data.revenue ?? {};
  const anomalies = data.anomalies ?? [];
  const currency  = revenue.currency ?? 'USD';

  const lines = [
    'COSA — Shift Report',
    '',
    `Period:  ${fmtTime(data.period_start)}  →  ${fmtTime(data.period_end)}`,
    '',
    'ORDERS',
    `  Total:      ${orders.total     ?? 0}`,
    `  Paid:       ${orders.paid      ?? 0}`,
    `  Cancelled:  ${orders.cancelled ?? 0}`,
    `  Refunded:   ${orders.refunded  ?? 0}`,
    `  Active:     ${orders.active    ?? 0}`,
    '',
    'REVENUE',
    `  Payments:        ${revenue.payment_count ?? 0}`,
    `  Payments total:  ${fmtMoney(revenue.payments_total)} ${currency}`,
    `  Service charge:  ${fmtMoney(revenue.service_charge_total)} ${currency}`,
    `  Grand total:     ${fmtMoney(revenue.total)} ${currency}`,
    `  Avg/order:       ${fmtMoney(revenue.avg_order_value)}`,
    '',
    'STAFF',
    `  On shift:       ${data.staff_count ?? 0}`,
    '',
    'SYSTEM',
    `  Payment errors: ${data.payment_errors ?? 0}`,
    '',
    `ANOMALIES (${anomalies.length})`,
  ];

  if (anomalies.length === 0) {
    lines.push('  None');
  } else {
    for (const a of anomalies) lines.push(`  - ${a}`);
  }

  lines.push('', '--- Automated report from COSA ---');
  return lines.join('\n');
}

async function runShiftReportTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;
  const today         = new Date().toISOString().slice(0, 10);
  const subject       = `[COSA] Shift Report: ${today}`;

  // Deduplication: suppress if a shift report was already sent in the last 6 hours.
  const sinceIso = new Date(Date.now() - SHIFT_REPORT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(SHIFT_REPORT_CATEGORY, 'info', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate shift report (last sent: ${recent.sent_at})`);
    return;
  }

  // Render the report deterministically from the tool output — no Claude session.
  // The shift report is pure metrics; a template covers every case.
  let data;
  try {
    data = await shiftReportTool.handler({});
  } catch (err) {
    log.error(`[shift-report] tool threw: ${err.message}`);
    data = null;
  }

  const body   = data ? formatShiftReportBody(data) : '(No shift report data available.)';
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject,
    text:    body,
  });

  createAlert({
    session_id: null, // no Claude session for shift_report
    severity:   'info',
    category:   SHIFT_REPORT_CATEGORY,
    title:      subject,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Shift report sent: ${subject}`);
}

/**
 * Generate and send the weekly operational digest email.
 *
 * Deduplication: no second digest if one was sent within the past 6 days.
 * Subject format: [COSA] Weekly Digest: week of YYYY-MM-DD
 * @returns {Promise<void>}
 */
async function runWeeklyDigestTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;
  const weekOf        = _getMondayDateString();
  const subject       = `[COSA] Weekly Digest: week of ${weekOf}`;

  // Deduplication: suppress if a digest was sent in the last 6 days.
  const sinceIso = new Date(Date.now() - DIGEST_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(DIGEST_CATEGORY, 'info', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate weekly digest (last sent: ${recent.sent_at})`);
    return;
  }

  const trigger                    = buildWeeklyDigestTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  const body   = response || '(No digest data available.)';
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject,
    text:    body,
  });

  createAlert({
    session_id: sessionId,
    severity:   'info',
    category:   DIGEST_CATEGORY,
    title:      subject,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Weekly digest sent: ${subject}`);
}

// ---------------------------------------------------------------------------
// Phase 3 cron tasks
// ---------------------------------------------------------------------------

/**
 * Run git_audit every 6 hours.  If any finding has severity >= medium,
 * Claude is instructed to call ips_alert within the session.
 * @returns {Promise<void>}
 */
async function runGitAuditTask() {
  // Run the tool directly first so we can skip the Claude session entirely
  // on clean runs (severity < medium), which is the common case.
  let auditResult;
  try {
    auditResult = await gitAuditTool.handler({});
  } catch (err) {
    log.error(`[git-audit] tool threw: ${err.message}`);
    auditResult = { severity: 'none', error: err.message };
  }

  const severity = auditResult.severity ?? 'none';

  if (!['medium', 'high', 'critical'].includes(severity)) {
    log.info(`Git audit complete: severity=${severity}`);
    return;
  }

  // Anomaly — run a Claude session so Claude can call ips_alert with a
  // narrative summary alongside the structured alert record below.
  const trigger                   = buildGitAuditTrigger();
  const { session_id: sessionId } = await runSessionWithTimeout(trigger);

  createAlert({
    session_id: sessionId,
    severity,
    category:   GIT_AUDIT_CATEGORY,
    title:      `Git audit: ${severity} finding`,
    body:       JSON.stringify(auditResult),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(`Git audit complete: severity=${severity}`);
}

/**
 * Run process_monitor every 6 hours.  If severity >= medium, Claude is
 * instructed to call ips_alert to trigger the escalation FSM.
 * @returns {Promise<void>}
 */
async function runProcessMonitorTask() {
  let monitorResult;
  try {
    monitorResult = await processMonitorTool.handler({});
  } catch (err) {
    log.error(`[process-monitor] tool threw: ${err.message}`);
    monitorResult = { severity: 'none', error: err.message };
  }

  const severity = monitorResult.severity ?? 'none';

  if (!['medium', 'high', 'critical'].includes(severity)) {
    log.info(`Process monitor complete: severity=${severity}`);
    return;
  }

  // Anomaly — run Claude session so ips_alert is triggered with narrative.
  const trigger                   = buildProcessMonitorTrigger();
  const { session_id: sessionId } = await runSessionWithTimeout(trigger);

  createAlert({
    session_id: sessionId,
    severity,
    category:   PROCESS_MONITOR_CATEGORY,
    title:      `Process monitor: ${severity} finding`,
    body:       JSON.stringify(monitorResult),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(`Process monitor complete: severity=${severity}`);
}

/**
 * Run network_scan every 6 hours.  If an unknown device is found,
 * Claude is instructed to call ips_alert within the session.
 * @returns {Promise<void>}
 */
async function runNetworkScanTask() {
  let scanResult;
  try {
    scanResult = await networkScanTool.handler({});
  } catch (err) {
    log.error(`[network-scan] tool threw: ${err.message}`);
    scanResult = { unknownDevices: [], error: err.message };
  }

  const unknownCount = (scanResult.unknownDevices ?? []).length;

  if (unknownCount === 0) {
    log.info(`Network scan complete: 0 unknown device(s)`);
    return;
  }

  const trigger                   = buildNetworkScanTrigger();
  const { session_id: sessionId } = await runSessionWithTimeout(trigger);

  createAlert({
    session_id: sessionId,
    severity:   'high',
    category:   NETWORK_SCAN_CATEGORY,
    title:      `Network scan: ${unknownCount} unknown device(s) detected`,
    body:       JSON.stringify(scanResult),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(`Network scan complete: ${unknownCount} unknown device(s)`);
}

/**
 * Run access_log_scan every 6 hours and feed results to the anomaly classifier.
 * Claude is instructed to call ips_alert if threat score >= medium.
 * @returns {Promise<void>}
 */
async function runAccessLogScanTask() {
  let scanResult;
  try {
    scanResult = await accessLogScanTool.handler({});
  } catch (err) {
    log.error(`[access-log-scan] tool threw: ${err.message}`);
    scanResult = { anomalies: [], error: err.message };
  }

  const anomalyCount = (scanResult.anomalies ?? []).length;

  if (anomalyCount === 0) {
    log.info(`Access log scan complete: 0 anomaly(s)`);
    return;
  }

  const trigger                   = buildAccessLogScanTrigger();
  const { session_id: sessionId } = await runSessionWithTimeout(trigger);

  createAlert({
    session_id: sessionId,
    severity:   scanResult.severity ?? 'warning',
    category:   ACCESS_LOG_CATEGORY,
    title:      `Access log scan: ${anomalyCount} anomaly(s) detected`,
    body:       JSON.stringify(scanResult),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(`Access log scan complete: ${anomalyCount} anomaly(s)`);
}

/**
 * Probe the cloudflared tunnel by hitting the configured public URL and
 * alerting on connection errors or 5xx responses.
 *
 * Cloudflare returns 521/522/523 when the origin (cloudflared on the
 * appliance) is unreachable, so any 5xx is a genuine signal. Any fetch
 * rejection (DNS, TLS, timeout, AbortSignal) is also treated as failure.
 *
 * @returns {Promise<void>}
 */
async function runTunnelHealthCheckTask() {
  const { appliance } = getConfig();
  const cfg = appliance.tools?.tunnel_health_check ?? {};

  const url       = cfg.url;
  const timeoutMs = cfg.timeout_ms ?? 10_000;
  const maxOk     = cfg.expected_status_max ?? 499;

  if (!url) {
    log.warn('[tunnel-health-check] no url configured; skipping');
    return;
  }

  let status;
  let error;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal:   AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    status = res.status;
  } catch (err) {
    error = err.message;
  }
  const elapsedMs = Date.now() - t0;

  const ok = !error && typeof status === 'number' && status <= maxOk;
  if (ok) {
    log.info(`Tunnel health OK: ${url} → ${status} in ${elapsedMs} ms`);
    return;
  }

  // Dedup — sustained outages should not email hourly.
  const sinceIso = new Date(Date.now() - TUNNEL_HEALTH_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(TUNNEL_HEALTH_CATEGORY, 'critical', sinceIso);
  if (recent) {
    log.warn(`Tunnel still failing (${error ?? `HTTP ${status}`}); alert suppressed by dedup`);
    return;
  }

  const summary = error
    ? `Cloudflared tunnel unreachable: ${error}`
    : `Cloudflared tunnel returned HTTP ${status}`;

  const operatorEmail = appliance.operator.email;
  const subject       = `[COSA] Tunnel health alert — ${url}`;
  const body =
    `${summary}\n\n` +
    `URL:        ${url}\n` +
    `Status:     ${status ?? 'n/a'}\n` +
    `Elapsed:    ${elapsedMs} ms\n` +
    `Timeout:    ${timeoutMs} ms\n` +
    (error ? `Error:      ${error}\n` : '') +
    `Checked at: ${new Date().toISOString()}\n`;

  await emailGateway.sendEmail({ to: operatorEmail, subject, text: body });

  createAlert({
    session_id: null,
    severity:   'critical',
    category:   TUNNEL_HEALTH_CATEGORY,
    title:      summary,
    body,
    sent_at:    new Date().toISOString(),
    email_to:   operatorEmail,
  });

  log.error(`[tunnel-health-check] ${summary}`);
}

/**
 * Generate and send the weekly security digest email on Monday at 2:00 AM.
 *
 * Deduplication: no second digest if one was sent within the past 6 days.
 * Subject format: [COSA] Weekly Security Digest: week of YYYY-MM-DD
 * @returns {Promise<void>}
 */
async function runWeeklySecurityDigestTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;
  const weekOf        = _getMondayDateString();
  const appName       = appliance.appliance?.name ?? 'COSA';
  const subject       = `[COSA] Weekly Security Digest — ${appName} — ${weekOf}`;

  const sinceIso = new Date(Date.now() - DIGEST_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(SEC_DIGEST_CATEGORY, 'info', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate security digest (last sent: ${recent.sent_at})`);
    return;
  }

  const trigger                    = buildWeeklySecurityDigestTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  const body   = response || '(No security digest data available.)';
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject,
    text:    body,
  });

  createAlert({
    session_id: sessionId,
    severity:   'info',
    category:   SEC_DIGEST_CATEGORY,
    title:      subject,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`Weekly security digest sent: ${subject}`);
}

/**
 * Pick the worst severity across a list of findings.
 * Ordering: critical > high > warning.
 * @param {Array<{ severity?: string }>} findings
 * @returns {'critical'|'high'|'warning'}
 */
function _worstSeverity(findings) {
  if (findings.some(f => f.severity === 'critical')) return 'critical';
  if (findings.some(f => f.severity === 'high'))     return 'high';
  return 'warning';
}

/**
 * Run credential_audit on Monday at 2:00 AM.
 *
 * No orchestrator / LLM session is used — the tool is invoked directly and the
 * alert body is built mechanically from its JSON output. This prevents the
 * composer (previously Haiku) from hallucinating fingerprints or conflating the
 * already-suppressed findings list with the active findings list.
 *
 * @returns {Promise<void>}
 */
async function runCredentialAuditTask() {
  let auditResult;
  try {
    auditResult = await credentialAuditTool.handler();
  } catch (err) {
    log.error(`Credential audit threw: ${err.message}`);
    return;
  }

  const findings           = Array.isArray(auditResult.findings)           ? auditResult.findings           : [];
  const suppressedFindings = Array.isArray(auditResult.suppressedFindings) ? auditResult.suppressedFindings : [];

  if (findings.length === 0) {
    log.info(
      `Credential audit complete: 0 active finding(s), ${suppressedFindings.length} suppressed`
    );
    return;
  }

  const severity = _worstSeverity(findings);

  // Evidence lines are built mechanically — one per active finding, each
  // quoting the exact file:line and fingerprint from the tool output. No
  // suppressed finding ever touches this list.
  const evidence = findings.map(f =>
    `${f.description ?? f.pattern} — ${f.file}:${f.line} — ${f.snippet ?? ''} ` +
    `(fingerprint: ${f.fingerprint})`
  );

  const responseOptions = findings.map(
    f => `SUPPRESS ${f.fingerprint} <reason>`
  );

  let ipsResult;
  try {
    ipsResult = await ipsAlertTool.handler({
      severity,
      incidentType:        `Credential Exposure — ${findings.length} active finding(s) detected`,
      evidence,
      actionsAlreadyTaken: 'Credential audit completed. Secret values redacted in output. No state changes made.',
      responseOptions,
      autoExpireMinutes:   30,
    });
  } catch (err) {
    log.error(`Credential audit: ips_alert dispatch failed: ${err.message}`);
    return;
  }

  createAlert({
    session_id: ipsResult?.alertRef ?? `cred-audit-${Date.now()}`,
    severity,
    category:   CREDENTIAL_AUDIT_CATEGORY,
    title:      `Credential audit: ${findings.length} finding(s)`,
    body:       JSON.stringify({
      findings,
      gitignoreCoverage: auditResult.gitignoreCoverage,
    }),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(
    `Credential audit complete: ${findings.length} active finding(s) ` +
    `(${severity}), ${suppressedFindings.length} suppressed — alert sent`
  );
}

/**
 * Run compliance_verify on Monday at 2:00 AM.  Results are included in the
 * weekly security digest via session_search.
 * @returns {Promise<void>}
 */
async function runComplianceVerifyTask() {
  const trigger                    = buildComplianceVerifyTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const verifyResult  = getLastToolOutput(sessionId, 'compliance_verify') ?? {};
  const failCount     = verifyResult.fail_count    ?? 0;
  const warningCount  = verifyResult.warning_count ?? 0;
  const overallStatus = failCount > 0
    ? 'non_compliant'
    : warningCount > 0
      ? 'needs_review'
      : 'compliant';

  createAlert({
    session_id: sessionId,
    severity:   failCount > 0 ? 'warning' : 'info',
    category:   COMPLIANCE_VERIFY_CATEGORY,
    title:      `Compliance verify: ${overallStatus}`,
    body:       JSON.stringify(verifyResult),
    sent_at:    new Date().toISOString(),
    email_to:   null,
  });

  log.info(`Compliance verify complete: ${overallStatus}`);
}

/**
 * Run webhook_hmac_verify on Monday at 2:00 AM.  Claude is instructed to call
 * ips_alert with severity critical if any webhook has HMAC inactive.
 * @returns {Promise<void>}
 */
async function runWebhookHmacVerifyTask() {
  const trigger                    = buildWebhookHmacTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const verifyResult   = getLastToolOutput(sessionId, 'webhook_hmac_verify') ?? {};
  const hmacNotEnforced = verifyResult.verified === false && verifyResult.status_code === 200;

  if (hmacNotEnforced) {
    createAlert({
      session_id: sessionId,
      severity:   'critical',
      category:   WEBHOOK_HMAC_CATEGORY,
      title:      'Webhook HMAC: endpoint accepted invalid signature (HTTP 200)',
      body:       JSON.stringify(verifyResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Webhook HMAC verify complete: hmacNotEnforced=${hmacNotEnforced}`);
}

/**
 * Run jwt_secret_check on Monday at 2:00 AM.  Claude is instructed to call
 * ips_alert with a rotation reminder if any secret is due.
 * @returns {Promise<void>}
 */
async function runJwtSecretCheckTask() {
  const trigger                    = buildJwtSecretCheckTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const checkResult  = getLastToolOutput(sessionId, 'jwt_secret_check') ?? {};
  const dueCount     = (checkResult.rotation_due ?? []).length;

  if (dueCount > 0) {
    createAlert({
      session_id: sessionId,
      severity:   'warning',
      category:   JWT_SECRET_CATEGORY,
      title:      `JWT secret check: ${dueCount} secret(s) due for rotation`,
      body:       JSON.stringify(checkResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`JWT secret check complete: ${dueCount} secret(s) due`);
}

/**
 * Run pci_assessment on the 1st of each month at 2:00 AM.  Claude is
 * instructed to email the full report to the operator.
 *
 * Deduplication: no second report within 25 days.
 * @returns {Promise<void>}
 */
async function runPciAssessmentTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;
  const monthOf       = new Date().toISOString().slice(0, 7);
  const subject       = `[COSA] Monthly PCI Assessment: ${monthOf}`;

  const sinceIso = new Date(Date.now() - MONTHLY_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(PCI_ASSESSMENT_CATEGORY, 'info', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate PCI assessment (last sent: ${recent.sent_at})`);
    return;
  }

  const trigger                    = buildPciAssessmentTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  const body   = response || '(No PCI assessment data available.)';
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject,
    text:    body,
  });

  createAlert({
    session_id: sessionId,
    severity:   'info',
    category:   PCI_ASSESSMENT_CATEGORY,
    title:      subject,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`PCI assessment sent: ${subject}`);
}

/**
 * Run token_rotation_remind on the 1st of each month at 2:00 AM.
 * Claude is instructed to email a reminder for tokens approaching deadline.
 *
 * Deduplication: no second reminder within 25 days.
 * @returns {Promise<void>}
 */
async function runTokenRotationRemindTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  const sinceIso = new Date(Date.now() - MONTHLY_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(TOKEN_ROTATION_CATEGORY, 'info', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate token rotation reminder (last sent: ${recent.sent_at})`);
    return;
  }

  const trigger                    = buildTokenRotationRemindTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  const monthOf = new Date().toISOString().slice(0, 7);
  const subject = `[COSA] Token Rotation Reminder: ${monthOf}`;

  // Only send an email if Claude's response indicates tokens are due.
  if (response && !/no tokens? (are )?due/i.test(response)) {
    const sentAt = new Date().toISOString();

    await emailGateway.sendEmail({
      to:      operatorEmail,
      subject,
      text:    response,
    });

    createAlert({
      session_id: sessionId,
      severity:   'info',
      category:   TOKEN_ROTATION_CATEGORY,
      title:      subject,
      body:       response,
      sent_at:    sentAt,
      email_to:   operatorEmail,
    });

    log.info(`Token rotation reminder sent: ${subject}`);
  } else {
    log.info('Token rotation check complete: no tokens due');
  }
}

// ---------------------------------------------------------------------------
// Resource threshold monitor task
// ---------------------------------------------------------------------------

/**
 * Build the plain-text alert email body for a resource threshold violation.
 *
 * @param {object} result   - handler() return value
 * @param {string} appName
 * @param {string} alertRef
 * @returns {string}
 */
function buildRtmEmailBody(result, appName, alertRef) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════╗');
  lines.push('║  COSA RESOURCE ALERT                                 ║');
  lines.push('╚══════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Appliance : ${appName}`);
  lines.push(`Alert Ref : ${alertRef}`);
  lines.push(`Issued At : ${new Date().toISOString()}`);
  lines.push('');

  lines.push('─── WHAT HAPPENED ────────────────────────────────────────');
  lines.push(`${result.findings.length} process(es) exceeded resource thresholds.`);
  lines.push('');

  lines.push('─── FINDINGS ─────────────────────────────────────────────');
  for (const f of result.findings) {
    switch (f.kind) {
      case 'spike':
        lines.push(`  • PID ${f.pid} [${f.command}]  spike  cpu=${f.cpu}%  threshold=${f.threshold}  severity=${f.severity}`);
        break;
      case 'sustained_cpu':
        lines.push(`  • PID ${f.pid} [${f.command}]  sustained_cpu  samples=[${f.samples.join(', ')}]  threshold=${f.threshold}  severity=${f.severity}`);
        break;
      case 'rss_over_sustained':
        lines.push(`  • PID ${f.pid} [${f.command}]  rss_over_sustained  samples_mb=[${f.rss_samples_mb.map(v => v.toFixed(0)).join(', ')}]  threshold=${f.threshold} MB  severity=${f.severity}`);
        break;
      case 'age_over':
        lines.push(`  • PID ${f.pid} [${f.command}]  age_over  age=${f.age_seconds}s  threshold=${f.threshold}s  severity=${f.severity}`);
        break;
      case 'aggregate_cpu':
        lines.push(`  • SYSTEM  aggregate_cpu  samples=[${f.samples.join(', ')}]  threshold=${f.threshold}%  severity=${f.severity}`);
        break;
      case 'system_memory_low':
        lines.push(`  • SYSTEM  system_memory_low  samples_mib=[${(f.samples_mib ?? []).map(v => v == null ? 'null' : v.toFixed(0)).join(', ')}]  floor=${f.floor_mib} MiB  severity=${f.severity}`);
        break;
      case 'singleton_orphan':
        lines.push(`  • PID ${f.pid} [${f.command}]  singleton_orphan  pattern="${f.pattern}"  age=${f.age_seconds}s  rss=${f.rss_mb != null ? f.rss_mb.toFixed(0) : '?'} MB`);
        lines.push(`      active PID=${f.active_pid}  active_age=${f.active_age_seconds}s`);
        lines.push(`      → likely orphaned by a service restart; safe to kill`);
        break;
      default:
        lines.push(`  • ${JSON.stringify(f)}`);
    }
  }
  lines.push('');

  lines.push('─── AGGREGATE ────────────────────────────────────────────');
  lines.push(`  Sampled processes: ${result.sampled_processes}   Samples taken: ${result.samples_taken}`);
  lines.push('');

  lines.push('─── RESPONSE OPTIONS ─────────────────────────────────────');
  lines.push('  • Approve kill of listed PIDs');
  lines.push('  • SSH in and investigate further');
  lines.push('');
  lines.push('──────────────────────────────────────────────────────────');
  lines.push('This alert was generated by COSA (Compute-Oriented System Agent).');

  return lines.join('\n');
}

/**
 * Run the resource threshold monitor every 5 minutes during business hours.
 *
 * Invokes the tool directly (no Claude session needed — the findings are
 * structured data, not free-form narrative).  Groups all findings into one
 * email per invocation to avoid mailbombing on a saturated appliance.
 * Deduplicates by (category, maxSeverity) within dedup_window_minutes.
 *
 * @returns {Promise<void>}
 */
async function runResourceThresholdTask() {
  const { appliance } = getConfig();
  const rtmConfig     = appliance.tools?.resource_threshold_monitor ?? {};

  // Belt-and-suspenders on top of the cron-skip guard in start().
  if (rtmConfig.enabled === false) return;

  const operatorEmail = appliance.operator?.email;
  const applianceName = appliance.appliance?.name ?? 'Appliance';

  let result;
  try {
    result = await resourceThresholdMonitorTool.handler();
  } catch (err) {
    log.error(`[rtm] tool threw: ${err.message}`);
    return;
  }

  if (result.skipped || !result.findings || result.findings.length === 0) {
    log.info(`[rtm] complete: 0 findings`);
    return;
  }

  log.info(`[rtm] complete: ${result.findings.length} finding(s)`);

  // Determine highest severity across all findings for dedup and alert record.
  const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
  const severities     = result.findings.map(f => f.severity ?? 'low');
  const maxSeverity    = SEVERITY_ORDER.find(s => severities.includes(s)) ?? 'low';

  // Dedup: suppress if the same (category, severity) was already alerted
  // within dedup_window_minutes.
  const dedupMs    = (rtmConfig.dedup_window_minutes ?? 30) * 60 * 1000;
  const sinceIso   = new Date(Date.now() - dedupMs).toISOString();
  const recent     = findRecentAlert(RESOURCE_THRESHOLD_CATEGORY, maxSeverity, sinceIso);
  if (recent) {
    log.info(`[rtm] suppressed duplicate ${maxSeverity} alert (last sent: ${recent.sent_at})`);
    return;
  }

  // Build and send a single grouped email.
  const alertRef = `RTM-${Date.now()}`;
  const title    = `${applianceName} — Resource Threshold Violation`;
  const body     = buildRtmEmailBody(result, applianceName, alertRef);
  const sentAt   = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: null,
    severity:   maxSeverity,
    category:   RESOURCE_THRESHOLD_CATEGORY,
    title,
    body,
    sent_at:    sentAt,
    email_to:   operatorEmail,
  });

  log.info(`[rtm] alert sent: ${alertRef} (${maxSeverity}, ${result.findings.length} findings)`);
}

// ---------------------------------------------------------------------------
// Auto-patch tasks
// ---------------------------------------------------------------------------

/**
 * Render the alert body for an auto-patch run.
 *
 * @param {{
 *   target: 'cosa'|'appliance',
 *   host: string,
 *   result: { ok: boolean, packagesUpgraded: number, rebootRequired: boolean,
 *             rebootScheduled: boolean, durationMs: number, logTail: string,
 *             error: string|null },
 * }} params
 * @returns {string}
 */
function buildAutoPatchAlertBody({ target, host, result }) {
  const lines = [
    `auto_patch run on ${host} (target=${target}):`,
    '',
    `Status:               ${result.ok ? 'success' : 'FAILURE'}`,
    `Packages upgraded:    ${result.packagesUpgraded}`,
    `Reboot required:      ${result.rebootRequired ? 'yes' : 'no'}`,
    `Reboot scheduled:     ${result.rebootScheduled ? 'yes (delayed shutdown)' : 'no'}`,
    `Duration:             ${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  if (result.error) {
    lines.push('', `Error: ${result.error}`);
  }
  if (result.logTail) {
    lines.push('', '--- apt log tail ---', result.logTail.trimEnd());
  }
  lines.push('', '--- Automated alert from COSA ---');
  return lines.join('\n');
}

/**
 * Shared body for both COSA-host and appliance auto-patch tasks.
 *
 * Always emails the operator: a success summary, or — per the operator's
 * "any failure must be notified immediately" requirement — a failure alert
 * with no dedup window. Configuration knobs come from
 * appliance.tools.<configKey>.
 *
 * @param {{
 *   target: 'cosa'|'appliance',
 *   configKey: string,
 *   category: string,
 *   defaultRebootIfRequired: boolean,
 *   defaultRebootDelayMinutes: number,
 * }} params
 * @returns {Promise<void>}
 */
async function _runAutoPatch({ target, configKey, category, defaultRebootIfRequired, defaultRebootDelayMinutes }) {
  const { appliance } = getConfig();
  const cfg           = appliance.tools?.[configKey] ?? {};

  if (cfg.enabled === false) return;

  const operatorEmail      = appliance.operator.email;
  const applianceName      = appliance.name ?? 'Appliance';
  const host               = target === 'cosa' ? 'cosa-host' : applianceName;
  const rebootIfRequired   = cfg.reboot_if_required !== false && defaultRebootIfRequired;
  const rebootDelayMinutes = cfg.reboot_delay_minutes ?? defaultRebootDelayMinutes;
  // Default 'upgrade' — conservative, never installs new packages or removes
  // existing ones. Set to 'full-upgrade' in appliance.yaml when you want apt
  // to resolve dependency changes (e.g. kernel meta-package transitions).
  const upgradeMode        = cfg.upgrade_mode ?? 'upgrade';

  log.info(`[${configKey}] starting auto_patch on ${target} (upgradeMode=${upgradeMode})`);

  let result;
  try {
    result = await autoPatchTool.handler({ target, upgradeMode, rebootIfRequired, rebootDelayMinutes });
  } catch (err) {
    result = {
      ok:               false,
      target,
      packagesUpgraded: 0,
      rebootRequired:   false,
      rebootScheduled:  false,
      durationMs:       0,
      logTail:          '',
      error:            `auto_patch threw: ${err.message}`,
    };
  }

  const severity = result.ok ? 'info' : 'critical';
  const titleVerb = result.ok
    ? (result.rebootScheduled ? 'patched + reboot scheduled' : 'patched')
    : 'patch FAILED';
  const title = `${applianceName} — ${target} ${titleVerb} (${result.packagesUpgraded} pkg)`;

  // Only notify the operator when action is needed: a patch failure or a
  // pending/scheduled reboot. Routine successful patches that require no
  // reboot are silent — no email, no alert.
  if (!result.ok || result.rebootRequired) {
    const body = buildAutoPatchAlertBody({ target, host, result });

    await emailGateway.sendEmail({
      to:      operatorEmail,
      subject: `[COSA Alert] ${title}`,
      text:    body,
    });

    createAlert({
      session_id: null,
      severity,
      category,
      title,
      body,
      sent_at:    new Date().toISOString(),
      email_to:   operatorEmail,
    });

    log.info(`[${configKey}] alert sent: ${title}`);
  } else {
    log.info(`[${configKey}] patches applied cleanly — no reboot required, no email sent`);
  }
}

/**
 * Run a full apt-get update + upgrade on the COSA host (local exec).
 * Schedules a delayed reboot if /var/run/reboot-required exists.
 * @returns {Promise<void>}
 */
async function runAutoPatchCosaTask() {
  return _runAutoPatch({
    target:                    'cosa',
    configKey:                 'auto_patch_cosa',
    category:                  AUTO_PATCH_COSA_CATEGORY,
    defaultRebootIfRequired:   true,
    defaultRebootDelayMinutes: 1,
  });
}

/**
 * Run a full apt-get update + upgrade on the managed appliance (via SSH).
 * Schedules a delayed reboot if /var/run/reboot-required exists.
 * @returns {Promise<void>}
 */
async function runAutoPatchApplianceTask() {
  return _runAutoPatch({
    target:                    'appliance',
    configKey:                 'auto_patch_appliance',
    category:                  AUTO_PATCH_APPLIANCE_CATEGORY,
    defaultRebootIfRequired:   true,
    defaultRebootDelayMinutes: 1,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const _tasks = new Map();

/**
 * Register all Phase 2 and Phase 3 cron tasks.
 * A second call while tasks are already running is a silent no-op.
 */
function start() {
  if (_tasks.size > 0) return;

  const { appliance } = getConfig();
  const cronConfig    = appliance.cron ?? {};

  const schedule = (key, defaultExpr, fn) => {
    // Honor `tools.<key>.enabled === false` from appliance.yaml so flag-off
    // tools don't get a noisy empty cron tick. Missing/undefined stays on by
    // default — only an explicit `false` skips registration.
    if (appliance.tools?.[key]?.enabled === false) {
      log.info(`Cron skipped (disabled in appliance.yaml): ${key}`);
      return;
    }
    const expr = cronConfig[key] ?? defaultExpr;
    const task = cron.schedule(expr, () => {
      fn().catch(err => log.error(`${key} task error: ${err.message}`));
    });
    _tasks.set(key, task);
    log.info(`Cron registered: ${key} (${expr})`);
  };

  // Internet IP watch — every 2 minutes, 24/7
  schedule('internet_ip_watch', '*/2 * * * *', runInternetIpWatchTask);

  // Phase 2
  // Adaptive health-check windows (all times local to the appliance timezone):
  //   11:00 AM – 2:00 PM  → every 30 min  (peak lunch)
  //   2:00 PM  – 5:00 PM  → every hour    (afternoon lull)
  //   5:00 PM  – 9:00 PM  → every 30 min  (peak dinner)
  //   9:00 PM  – 11:00 AM → no check      (closed hours)
  schedule('health_check_lunch',   '0,30 11-13 * * *', runHealthCheckTask);
  schedule('health_check_midday',  '0 14-16 * * *',    runHealthCheckTask);
  schedule('health_check_dinner',  '0,30 17-20 * * *', runHealthCheckTask);
  schedule('backup',        '0 3 * * *',   runBackupTask);
  schedule('backup_verify', '5 3 * * *',   runBackupVerifyTask);
  schedule('archive_check', '10 3 * * *',  runArchiveCheckTask);
  schedule('shift_report',  '0 6 * * *',   runShiftReportTask);
  schedule('weekly_digest', '0 2 * * 1',   runWeeklyDigestTask);

  // Phase 3 — every 6 hours
  schedule('git_audit',       '0 */8 * * *', runGitAuditTask);
  schedule('process_monitor', '0 */8 * * *', runProcessMonitorTask);
  schedule('network_scan',    '0 */8 * * *', runNetworkScanTask);
  schedule('access_log_scan', '0 */8 * * *', runAccessLogScanTask);

  // Hourly — public ingress reachability via cloudflared tunnel
  schedule('tunnel_health_check', '0 * * * *', runTunnelHealthCheckTask);

  // Phase 3 — weekly Monday 2:00 AM
  schedule('security_digest',    '0 2 * * 1', runWeeklySecurityDigestTask);
  schedule('credential_audit',   '0 2 * * 1', runCredentialAuditTask);
  schedule('compliance_verify',  '0 2 * * 1', runComplianceVerifyTask);
  schedule('webhook_hmac_verify', '0 2 * * 1', runWebhookHmacVerifyTask);
  schedule('jwt_secret_check',   '0 2 * * 1', runJwtSecretCheckTask);

  // Phase 3 — monthly 1st 2:00 AM
  schedule('pci_assessment',        '0 2 1 * *', runPciAssessmentTask);
  schedule('token_rotation_remind', '0 2 1 * *', runTokenRotationRemindTask);

  // Resource threshold monitor — every 5 min during business hours
  schedule('resource_threshold_monitor', '*/5 8-21 * * *', runResourceThresholdTask);

  // Auto-patch — runs once daily at fixed times, 13 hours apart so they
  // never run concurrently. Appliance at 01:00 (low-traffic window); COSA
  // host at 14:00 (server can absorb a brief reboot mid-afternoon).
  schedule('auto_patch_appliance', '0 1 * * *',  runAutoPatchApplianceTask);
  schedule('auto_patch_cosa',      '0 14 * * *', runAutoPatchCosaTask);
}

/**
 * Stop and destroy all registered cron tasks.
 */
function stop() {
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  // Individual task runners exported for testing and manual invocation.
  runInternetIpWatchTask,
  runHealthCheckTask,
  runBackupTask,
  runBackupVerifyTask,
  runArchiveCheckTask,
  runShiftReportTask,
  formatShiftReportBody,
  runWeeklyDigestTask,
  // Phase 3 task runners
  runGitAuditTask,
  runProcessMonitorTask,
  runNetworkScanTask,
  runAccessLogScanTask,
  runTunnelHealthCheckTask,
  runWeeklySecurityDigestTask,
  runCredentialAuditTask,
  runComplianceVerifyTask,
  runWebhookHmacVerifyTask,
  runJwtSecretCheckTask,
  runPciAssessmentTask,
  runTokenRotationRemindTask,
  runResourceThresholdTask,
  runAutoPatchCosaTask,
  runAutoPatchApplianceTask,
  buildAutoPatchAlertBody,
  // Trigger builders exported for testing.
  buildHealthCheckTrigger,
  buildBackupTrigger,
  buildShiftReportTrigger,
  buildWeeklyDigestTrigger,
  buildGitAuditTrigger,
  buildProcessMonitorTrigger,
  buildNetworkScanTrigger,
  buildAccessLogScanTrigger,
  buildWeeklySecurityDigestTrigger,
  buildComplianceVerifyTrigger,
  buildWebhookHmacTrigger,
  buildJwtSecretCheckTrigger,
  buildPciAssessmentTrigger,
  buildTokenRotationRemindTrigger,
  _getMondayDateString,
  // IP watch helpers exported for testing.
  _isValidIpv4,
  _readIpState,
  _writeIpState,
  buildIpChangeAlertBody,
};
