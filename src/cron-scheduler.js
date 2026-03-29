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

/** Category tag stored in the alerts table. */
const HEALTH_CHECK_CATEGORY = 'health_check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the structured trigger message passed to the orchestrator for a
 * scheduled health check (§11.2 of the COSA spec).
 *
 * @returns {{ type: string, source: string, message: string }}
 */
function buildHealthCheckTrigger() {
  return {
    type:    'cron',
    source:  'health-check',
    message: `You are running the scheduled hourly health check for Baanbaan.

Run the health_check tool to assess the appliance state. If the result is healthy, log it and take no further action. If degraded or unreachable, diagnose using db_integrity if needed, then send an alert email to the operator with the findings and recommendations.

Current time: ${new Date().toISOString()}`,
  };
}

/**
 * Compose a plain-text alert email body from a health-check result.
 *
 * @param {object} result - Return value from orchestrator.runSession().
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
// Core task
// ---------------------------------------------------------------------------

/**
 * Execute a full health-check orchestrator session and handle the result:
 * - healthy   → no email; result already persisted to session.db
 * - degraded  → send 'warning' alert email (subject to deduplication)
 * - unreachable → send 'critical' alert email (subject to deduplication)
 *
 * @returns {Promise<void>}
 */
async function runHealthCheckTask() {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator.email;

  const trigger                    = buildHealthCheckTrigger();
  const { session_id: sessionId }  = await orchestrator.runSession(trigger);

  // The orchestrator persists tool call results to session.db.
  // Read the health_check output from the DB so we're not parsing LLM text.
  const healthResult   = getLastToolOutput(sessionId, 'health_check') ?? {};
  const overall_status = healthResult.overall_status ?? 'unreachable';

  if (overall_status === 'healthy') {
    log.info(`Health check complete: ${overall_status}`);
    return;
  }

  // ── Degraded or unreachable: build alert ──────────────────────────────────
  const severity = overall_status === 'unreachable' ? 'critical' : 'warning';

  // Deduplication: suppress if the same alert was sent within the last 60 min.
  const sinceIso = new Date(Date.now() - ALERT_DEDUP_WINDOW_MS).toISOString();
  const recent   = findRecentAlert(HEALTH_CHECK_CATEGORY, severity, sinceIso);

  if (recent) {
    log.info(`Suppressed duplicate ${severity} alert (last sent: ${recent.sent_at})`);
    return;
  }

  const title  = overall_status === 'unreachable'
    ? 'Baanbaan is UNREACHABLE'
    : 'Baanbaan health is DEGRADED';
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** @type {import('node-cron').ScheduledTask | null} */
let _task = null;

/**
 * Register the health-check cron task using the expression from
 * `appliance.cron.health_check` in `config/appliance.yaml`.
 *
 * A second call while the task is already running is a silent no-op.
 */
function start() {
  if (_task !== null) return;

  const { appliance } = getConfig();
  const expression    = appliance.cron?.health_check ?? '0 * * * *';

  _task = cron.schedule(expression, () => {
    runHealthCheckTask().catch(err =>
      log.error(`Health check task error: ${err.message}`)
    );
  });
}

/**
 * Stop and destroy the registered cron task.
 */
function stop() {
  if (_task !== null) {
    _task.stop();
    _task = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { start, stop, runHealthCheckTask };
