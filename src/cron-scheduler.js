'use strict';

const cron = require('node-cron');
const { getConfig }    = require('../config/cosa.config');
const orchestrator     = require('./orchestrator');
const emailGateway     = require('./email-gateway');
const { createAlert, findRecentAlert, getLastToolOutput } = require('./session-store');
const { createLogger } = require('./logger');

const log = createLogger('cron-scheduler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suppress a repeat alert for the same category + severity within this window. */
const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Suppress a second shift report within this window (6 hours). */
const SHIFT_REPORT_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Suppress a second weekly digest if one was sent within the past 6 days. */
const DIGEST_DEDUP_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Suppress a second monthly report within 25 days. */
const MONTHLY_DEDUP_WINDOW_MS = 25 * 24 * 60 * 60 * 1000;

/** Category tags stored in the alerts table. */
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
// Trigger builders
// ---------------------------------------------------------------------------

/** @returns {{ type: string, source: string, message: string }} */
function buildHealthCheckTrigger() {
  return {
    type:    'cron',
    source:  'health-check',
    message: `You are running the scheduled hourly health check for Baanbaan.

Run the health_check tool to assess the appliance state. If the result is healthy, log it and take no further action. If degraded or unreachable, diagnose using db_integrity if needed, then send an alert email to the operator with the findings and recommendations.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildBackupTrigger() {
  return {
    type:    'cron',
    source:  'backup',
    message: `Scheduled nightly backup. Run backup_run to create a backup of the appliance database. If successful, run backup_verify to confirm the checksum. Update MEMORY.md with the backup status. If backup fails, send an alert email to the operator.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildBackupVerifyTrigger() {
  return {
    type:    'cron',
    source:  'backup-verify',
    message: `Verify the most recent appliance backup. Run backup_verify and report. If checksum mismatch or file missing, send an alert email to the operator immediately.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildArchiveCheckTrigger() {
  return {
    type:    'cron',
    source:  'archive-check',
    message: `Archive integrity check. Run session_search for any backup failure or anomaly mentions in the last 7 days. If a recurring pattern is found, summarise it and send an alert email to the operator.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildShiftReportTrigger() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    type:    'cron',
    source:  'shift-report',
    message: `Generate and send the daily shift report for the past 24 hours. Run shift_report to gather the data, then format a plain-text email and send it to the operator.

The email subject must be exactly: [COSA] Shift Report: ${today}
The email must be plain text — no HTML.

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
    message: `Generate the weekly operational digest and send it to the operator.

Gather data as follows:
1. Run session_search with query "backup success failure" to summarise backup status for the past 7 days.
2. Run session_search with query "health degraded unreachable alert" to summarise health check results for the past 7 days.
3. Query the skills database via session_search for skills created or improved this week.
4. Count operator-initiated sessions and approval requests from the past 7 days.

Then format a plain-text email (no HTML) matching this exact structure:
- Header: appliance name and "Weekly Operational Digest"
- Week range: week of ${weekOf}
- Section: HEALTH CHECK (N runs, healthy/failed counts, incidents)
- Section: BACKUPS (N runs, successful/failed counts, most recent backup date)
- Section: ANOMALIES THIS WEEK
- Section: SKILLS (new skills created, skills improved)
- Section: OPERATOR ACTIVITY (sessions, approval requests)
- Footer: "— COSA"

The email subject must be exactly: [COSA] Weekly Digest: week of ${weekOf}
The email must be plain text — no HTML.

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
    message: `Generate the weekly security digest and send it to the operator.

Gather data as follows:
1. Run session_search with query "git_audit severity medium high critical" for the past 7 days.
2. Run session_search with query "process_monitor unexpected missing" for the past 7 days.
3. Run session_search with query "network_scan unknown device" for the past 7 days.
4. Run session_search with query "access_log anomaly threat brute" for the past 7 days.
5. Run compliance_verify to get the current compliance posture and JWT rotation date.
6. Run credential_audit to check for exposed credentials in the repository.
7. Run session_search with query "webhook_hmac jwt_secret" for the past 7 days.
8. Count total security alert sessions from the past 7 days for the incident count.

Then format a plain-text email (no HTML) with this exact structure:
- Header: appliance name, "Weekly Security Digest — week of ${weekOf}"
- Section: GIT AUDIT — mark ✓ if no findings, or ⚠ with findings count and highest severity
- Section: PROCESS MONITOR — mark ✓ if all expected processes running, or ⚠ with unexpected/missing process names
- Section: NETWORK — mark ✓ if all devices known, or ⚠ with unknown device count and MAC addresses
- Section: ACCESS LOG ANOMALIES — mark ✓ if none, or ⚠ with count and top threat categories
- Section: COMPLIANCE — SAQ-A overall status; include JWT last-rotated date and next rotation date
- Section: CREDENTIALS — mark ✓ if no findings, or ⚠ with credential_audit summary; note .gitignore coverage
- Line: SECURITY INCIDENTS THIS WEEK: N
- Footer: Next scan: ${nextScanDate} | Next PCI assessment: ${nextPciDate}
- Footer: "— COSA Security Monitor"

Use ✓ to indicate a clean result and ⚠ followed by specific details for any anomaly or finding.
The email must be plain text — no HTML.

Retrieve the appliance name from the config and use it in the subject.
The email subject must follow this exact format: [COSA] Weekly Security Digest — <appliance name> — ${weekOf}

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildCredentialAuditTrigger() {
  return {
    type:    'cron',
    source:  'credential-audit',
    message: `Scheduled credential audit. Run credential_audit to check all stored credentials for age, strength, and exposure risk.

If any finding is present (any credential is weak, expired, or at risk), immediately run ips_alert with the findings summary to alert the operator.

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

Format the complete assessment as a plain-text email covering all 13 SAQ-A requirements and send it to the operator.

The email subject must be exactly: [COSA] Monthly PCI Assessment: ${monthOf}
The email must be plain text — no HTML.

Current time: ${new Date().toISOString()}`,
  };
}

/** @returns {{ type: string, source: string, message: string }} */
function buildTokenRotationRemindTrigger() {
  return {
    type:    'cron',
    source:  'token-rotation-remind',
    message: `Monthly token rotation reminder. Run token_rotation_remind to check all API tokens and service credentials for upcoming rotation deadlines.

Send a reminder email to the operator listing any tokens approaching or past their rotation deadline. Include token name (not value), days until deadline, and recommended action.

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

// ---------------------------------------------------------------------------
// Core cron tasks
// ---------------------------------------------------------------------------

/**
 * Execute a full health-check orchestrator session and handle the result.
 * healthy   → no email
 * degraded  → send 'warning' alert email (dedup 60 min)
 * unreachable → send 'critical' alert email (dedup 60 min)
 * @returns {Promise<void>}
 */
async function runHealthCheckTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  const trigger                    = buildHealthCheckTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

  const healthResult   = getLastToolOutput(sessionId, 'health_check') ?? {};
  const overall_status = healthResult.overall_status ?? 'unreachable';

  if (overall_status === 'healthy') {
    log.info(`Health check complete: ${overall_status}`);
    return;
  }

  const severity = overall_status === 'unreachable' ? 'critical' : 'warning';
  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(HEALTH_CHECK_CATEGORY, severity, sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate ${severity} alert (last sent: ${recent.sent_at})`);
    return;
  }

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
    session_id: sessionId,
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
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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

  const trigger                    = buildBackupVerifyTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

  const verifyResult = getLastToolOutput(sessionId, 'backup_verify') ?? {};

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
    session_id: sessionId,
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

  const trigger                    = buildArchiveCheckTrigger();
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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
  const trigger                    = buildGitAuditTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

  const auditResult = getLastToolOutput(sessionId, 'git_audit') ?? {};
  const severity    = auditResult.severity ?? 'none';

  if (['medium', 'high', 'critical'].includes(severity)) {
    createAlert({
      session_id: sessionId,
      severity,
      category:   GIT_AUDIT_CATEGORY,
      title:      `Git audit: ${severity} finding`,
      body:       JSON.stringify(auditResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Git audit complete: severity=${severity}`);
}

/**
 * Run process_monitor every 6 hours.  If severity >= medium, Claude is
 * instructed to call ips_alert to trigger the escalation FSM.
 * @returns {Promise<void>}
 */
async function runProcessMonitorTask() {
  const trigger                    = buildProcessMonitorTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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
 * Run credential_audit on Monday at 2:00 AM.  Claude is instructed to call
 * ips_alert within the session if any finding is present.
 * @returns {Promise<void>}
 */
async function runCredentialAuditTask() {
  const trigger                    = buildCredentialAuditTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

  const auditResult  = getLastToolOutput(sessionId, 'credential_audit') ?? {};
  const findingCount = (auditResult.findings ?? []).length;

  if (findingCount > 0) {
    createAlert({
      session_id: sessionId,
      severity:   auditResult.severity ?? 'warning',
      category:   CREDENTIAL_AUDIT_CATEGORY,
      title:      `Credential audit: ${findingCount} finding(s)`,
      body:       JSON.stringify(auditResult),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  }

  log.info(`Credential audit complete: ${findingCount} finding(s)`);
}

/**
 * Run compliance_verify on Monday at 2:00 AM.  Results are included in the
 * weekly security digest via session_search.
 * @returns {Promise<void>}
 */
async function runComplianceVerifyTask() {
  const trigger                    = buildComplianceVerifyTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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
  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

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

  // Phase 2
  schedule('health_check',  '0 * * * *',   runHealthCheckTask);
  schedule('backup',        '0 3 * * *',   runBackupTask);
  schedule('backup_verify', '5 3 * * *',   runBackupVerifyTask);
  schedule('archive_check', '10 3 * * *',  runArchiveCheckTask);
  schedule('shift_report',  '0 6 * * *',   runShiftReportTask);
  schedule('weekly_digest', '0 2 * * 1',   runWeeklyDigestTask);

  // Phase 3 — every 6 hours
  schedule('git_audit',       '0 */6 * * *', runGitAuditTask);
  schedule('process_monitor', '0 */6 * * *', runProcessMonitorTask);
  schedule('network_scan',    '0 */6 * * *', runNetworkScanTask);
  schedule('access_log_scan', '0 */6 * * *', runAccessLogScanTask);

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
  buildCredentialAuditTrigger,
  buildComplianceVerifyTrigger,
  buildWebhookHmacTrigger,
  buildJwtSecretCheckTrigger,
  buildPciAssessmentTrigger,
  buildTokenRotationRemindTrigger,
  _getMondayDateString,
};
