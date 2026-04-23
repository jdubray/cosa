'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
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
const sessionSearchTool      = require('./tools/session-search');

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

/** Suppress a second weekly digest if one was sent within the past 6 days. */
const DIGEST_DEDUP_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Suppress a second monthly report within 25 days. */
const MONTHLY_DEDUP_WINDOW_MS = 25 * 24 * 60 * 60 * 1000;

/** Category tags stored in the alerts table. */
const INTERNET_IP_WATCH_CATEGORY  = 'internet_ip_watch';
const HEALTH_CHECK_CATEGORY       = 'health_check';
const BACKUP_CATEGORY             = 'backup';
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

  const nextScanDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextPciDate  = (() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();

  return {
    type:    'cron',
    source:  'security-digest',
    message: `Generate the weekly security digest. Gather data as follows:
1. Run session_search with query "git_audit severity medium high critical" for the past 7 days.
2. Run session_search with query "process_monitor unexpected missing" for the past 7 days.
3. Run session_search with query "network_scan unknown device" for the past 7 days.
4. Run session_search with query "access_log anomaly threat brute" for the past 7 days.
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
- Section: ACCESS LOG ANOMALIES — mark ✓ if none, or ⚠ with count and top threat categories
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
  // grep exits 0 when the key exists; 1 when absent.
  const existsResult = await sshBackend.exec(`grep -q '^${key}=' '${envFilePath}'`);
  if (existsResult.exitCode !== 0) {
    return { updated: false, error: `Key ${key} not found in ${envFilePath}` };
  }

  // Read current value so we can handle comma-separated lists correctly.
  const readResult = await sshBackend.exec(`grep '^${key}=' '${envFilePath}'`);
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
  const sedCmd       = `sed -i 's|^${key}=.*|${key}=${escapedValue}|' '${envFilePath}'`;
  const sedResult    = await sshBackend.exec(sedCmd);
  if (sedResult.exitCode !== 0) {
    return { updated: false, error: `sed failed (exit ${sedResult.exitCode}): ${sedResult.stderr.trim()}` };
  }

  return { updated: true, error: null };
}

/**
 * Build the plain-text alert email body for a public-IP change event.
 *
 * @param {{ applianceName: string, oldIp: string|null, newIp: string, wasDown: boolean, updatedKeys: string[], restartedService: boolean, errors: string[] }} params
 * @returns {string}
 */
function buildIpChangeAlertBody({ applianceName, oldIp, newIp, wasDown, updatedKeys, restartedService, errors }) {
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

  lines.push(`Service restart: ${restartedService ? 'yes' : 'no (disabled or skipped)'}`);

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
  const serviceName      = watchConfig.service_name ?? 'baanbaan';

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

  // ── 5. Restart service if any key was updated ─────────────────────────────
  let restartedService = false;
  if (updatedKeys.length > 0 && restartOnChange && sshBackend.isConnected()) {
    try {
      const restartResult = await sshBackend.exec(`sudo systemctl restart ${serviceName}`);
      if (restartResult.exitCode === 0) {
        restartedService = true;
        log.info(`[internet-ip-watch] Service ${serviceName} restarted`);
      } else {
        errors.push(`systemctl restart ${serviceName} failed (exit ${restartResult.exitCode})`);
        log.error(`[internet-ip-watch] Service restart failed: ${restartResult.stderr.trim()}`);
      }
    } catch (err) {
      errors.push(`Service restart: ${err.message}`);
      log.error(`[internet-ip-watch] Service restart threw: ${err.message}`);
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
  const title = wasDown
    ? `${applianceName} — Internet restored, public IP updated to ${newIp}`
    : `${applianceName} — Public IP changed to ${newIp}`;

  const body    = buildIpChangeAlertBody({
    applianceName,
    oldIp: state.lastKnownIp,
    newIp,
    wasDown,
    updatedKeys,
    restartedService,
    errors,
  });
  const sentAt  = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject: `[COSA Alert] ${title}`,
    text:    body,
  });

  createAlert({
    session_id: crypto.randomUUID(),
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
        session_id: crypto.randomUUID(),
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
    session_id: crypto.randomUUID(), // no Claude session for health checks
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

  const trigger                    = buildBackupTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const backupResult = getLastToolOutput(sessionId, 'backup_run') ?? {};

  if (backupResult.success) {
    log.info(`Backup complete: ${backupResult.row_count} rows → ${backupResult.backup_path}`);
    return;
  }

  // Failure path
  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(BACKUP_CATEGORY, 'critical', sinceIso);

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
    session_id: sessionId,
    severity:   'critical',
    category:   BACKUP_CATEGORY,
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

  let verifyResult;
  try {
    verifyResult = await backupVerifyTool.handler({});
  } catch (err) {
    log.error(`[backup-verify] tool threw: ${err.message}`);
    verifyResult = { verified: false, error: err.message };
  }

  if (verifyResult.verified) {
    log.info(`Backup verification passed: ${verifyResult.backup_path}`);
    return;
  }

  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(BACKUP_CATEGORY, 'critical', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate backup-verify alert`);
    return;
  }

  const applianceName = appliance.name ?? 'Appliance';
  const title  = `${applianceName} — Backup Verification Failed`;
  const body   = [
    'COSA automated backup verification failed:',
    '',
    `Backup path:    ${verifyResult.backup_path ?? 'unknown'}`,
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
    session_id: crypto.randomUUID(), // no Claude session for backup_verify
    severity:   'critical',
    category:   BACKUP_CATEGORY,
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

  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(ARCHIVE_CHECK_CATEGORY, 'warning', sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate archive-check alert (last sent: ${recent.sent_at})`);
    return;
  }

  // Pre-filter: search the session store directly for backup-anomaly mentions
  // in the past 7 days.  Skip the Claude session entirely when there's nothing
  // for it to narrate — the common case on a healthy appliance.
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let searchResult;
  try {
    searchResult = sessionSearchTool.handler({
      query: 'backup AND (failure OR anomaly OR corrupt OR mismatch)',
      limit: 20,
    });
  } catch (err) {
    log.error(`[archive-check] session_search threw: ${err.message}`);
    return;
  }

  const recentMatches = (searchResult?.results ?? []).filter(r => {
    const ts = Date.parse(r.started_at ?? r.created_at ?? '');
    return Number.isFinite(ts) && ts >= sevenDaysAgoMs;
  });

  if (recentMatches.length === 0) {
    log.info('Archive check clean: no backup anomaly mentions in the past 7 days');
    return;
  }

  const trigger                    = buildArchiveCheckTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  // If COSA's response contains an alert indicator, record it for dedup.
  // COSA is instructed to report "ALERT:" when a recurring pattern is found.
  if (response && /ALERT:/i.test(response)) {
    const title  = 'Archive integrity anomaly detected';
    const sentAt = new Date().toISOString();

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

  const trigger                    = buildShiftReportTrigger();
  const { session_id: sessionId, response } = await runSessionWithTimeout(trigger);

  // Use the orchestrator's final response as the email body.
  // COSA is instructed to format the full plain-text report as its response.
  const body   = response || '(No shift report data available.)';
  const sentAt = new Date().toISOString();

  await emailGateway.sendEmail({
    to:      operatorEmail,
    subject,
    text:    body,
  });

  createAlert({
    session_id: sessionId,
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
  const trigger                    = buildProcessMonitorTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const monitorResult = getLastToolOutput(sessionId, 'process_monitor') ?? {};
  const severity      = monitorResult.severity ?? 'none';

  if (['medium', 'high', 'critical'].includes(severity)) {
    createAlert({
      session_id: sessionId,
      severity,
      category:   PROCESS_MONITOR_CATEGORY,
      title:      `Process monitor: ${severity} finding`,
      body:       JSON.stringify(monitorResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Process monitor complete: severity=${severity}`);
}

/**
 * Run network_scan every 6 hours.  If an unknown device is found,
 * Claude is instructed to call ips_alert within the session.
 * @returns {Promise<void>}
 */
async function runNetworkScanTask() {
  const trigger                    = buildNetworkScanTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const scanResult    = getLastToolOutput(sessionId, 'network_scan') ?? {};
  const unknownCount  = (scanResult.unknownDevices ?? []).length;

  if (unknownCount > 0) {
    createAlert({
      session_id: sessionId,
      severity:   'high',
      category:   NETWORK_SCAN_CATEGORY,
      title:      `Network scan: ${unknownCount} unknown device(s) detected`,
      body:       JSON.stringify(scanResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Network scan complete: ${unknownCount} unknown device(s)`);
}

/**
 * Run access_log_scan every 6 hours and feed results to the anomaly classifier.
 * Claude is instructed to call ips_alert if threat score >= medium.
 * @returns {Promise<void>}
 */
async function runAccessLogScanTask() {
  const trigger                    = buildAccessLogScanTrigger();
  const { session_id: sessionId }  = await runSessionWithTimeout(trigger);

  const scanResult  = getLastToolOutput(sessionId, 'access_log_scan') ?? {};
  const anomalyCount = (scanResult.anomalies ?? []).length;

  if (anomalyCount > 0) {
    createAlert({
      session_id: sessionId,
      severity:   scanResult.severity ?? 'warning',
      category:   ACCESS_LOG_CATEGORY,
      title:      `Access log scan: ${anomalyCount} anomaly(s) detected`,
      body:       JSON.stringify(scanResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Access log scan complete: ${anomalyCount} anomaly(s)`);
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

  // Phase 3 — weekly Monday 2:00 AM
  schedule('security_digest',    '0 2 * * 1', runWeeklySecurityDigestTask);
  schedule('credential_audit',   '0 2 * * 1', runCredentialAuditTask);
  schedule('compliance_verify',  '0 2 * * 1', runComplianceVerifyTask);
  schedule('webhook_hmac_verify', '0 2 * * 1', runWebhookHmacVerifyTask);
  schedule('jwt_secret_check',   '0 2 * * 1', runJwtSecretCheckTask);

  // Phase 3 — monthly 1st 2:00 AM
  schedule('pci_assessment',        '0 2 1 * *', runPciAssessmentTask);
  schedule('token_rotation_remind', '0 2 1 * *', runTokenRotationRemindTask);
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
  runWeeklyDigestTask,
  // Phase 3 task runners
  runGitAuditTask,
  runProcessMonitorTask,
  runNetworkScanTask,
  runAccessLogScanTask,
  runWeeklySecurityDigestTask,
  runCredentialAuditTask,
  runComplianceVerifyTask,
  runWebhookHmacVerifyTask,
  runJwtSecretCheckTask,
  runPciAssessmentTask,
  runTokenRotationRemindTask,
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
