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

/** Category tags stored in the alerts table. */
const HEALTH_CHECK_CATEGORY  = 'health_check';
const BACKUP_CATEGORY        = 'backup';
const ARCHIVE_CHECK_CATEGORY = 'archive_check';
const SHIFT_REPORT_CATEGORY  = 'shift_report';
const DIGEST_CATEGORY        = 'digest';

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
// Lifecycle
// ---------------------------------------------------------------------------

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const _tasks = new Map();

/**
 * Register all Phase 2 cron tasks.
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

  schedule('health_check',  '0 * * * *',   runHealthCheckTask);
  schedule('backup',        '0 3 * * *',   runBackupTask);
  schedule('backup_verify', '5 3 * * *',   runBackupVerifyTask);
  schedule('archive_check', '10 3 * * *',  runArchiveCheckTask);
  schedule('shift_report',  '0 6 * * *',   runShiftReportTask);
  schedule('weekly_digest', '0 2 * * 1',   runWeeklyDigestTask);
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
  // Trigger builders exported for testing.
  buildHealthCheckTrigger,
  buildBackupTrigger,
  buildShiftReportTrigger,
  buildWeeklyDigestTrigger,
  _getMondayDateString,
};
