'use strict';

const sshBackend                  = require('../ssh-backend');
const { getConfig }               = require('../../config/cosa.config');
const { createAlert }             = require('../session-store');
const { createLogger }            = require('../logger');

const log = createLogger('pause-appliance');

const PAUSE_APPLIANCE_CATEGORY = 'pause_appliance';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'pause_appliance';
const RISK_LEVEL = 'critical';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Stop the appliance service via systemd or pm2 (determined by ' +
    'the process_supervisor config), then perform a single GET /health check to ' +
    'confirm the service is no longer reachable. Returns success=true only when ' +
    'the health endpoint is unreachable after the stop command completes.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allowable characters for a service name (prevents SSH command injection). */
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_\-.]+$/;

/**
 * Perform a single HTTP GET with a hard AbortController timeout.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ reachable: boolean, status_code: number|null, body: object|null }>}
 */
async function httpGet(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    return { reachable: true, status_code: res.status, body };
  } catch {
    clearTimeout(timer);
    return { reachable: false, status_code: null, body: null };
  }
}

/**
 * Issue a stop command for the given supervisor type via SSH.
 *
 * @param {'systemd'|'pm2'} supervisorType
 * @param {string} serviceName
 * @returns {Promise<void>}
 * @throws {Error} If serviceName fails the safety check or the command exits non-zero.
 */
async function issueStop(supervisorType, serviceName) {
  if (!SAFE_SERVICE_NAME.test(serviceName)) {
    throw new Error(
      `Invalid service name '${serviceName}': must match ${SAFE_SERVICE_NAME}`
    );
  }

  const cmd = supervisorType === 'pm2'
    ? `pm2 stop ${serviceName}`
    : `systemctl stop ${serviceName}`;

  const { exitCode, stderr } = await sshBackend.exec(cmd);
  if (exitCode !== 0) {
    throw new Error(
      `Stop command (${cmd}) exited with code ${exitCode}: ${stderr.trim()}`
    );
  }
}

// ---------------------------------------------------------------------------
// Audit persistence
// ---------------------------------------------------------------------------

/**
 * Write a pause_appliance event to the alerts table in session.db.
 * session_id is null because tool handlers have no direct access to the
 * orchestrator session; the full session context is queryable via session.db.
 *
 * @param {object} result
 * @param {string} supervisorType
 * @param {string} serviceName
 * @param {string} stopIssuedAt
 */
function _persistAuditRecord(result, supervisorType, serviceName, stopIssuedAt) {
  try {
    const severity = result.success ? 'critical' : 'critical';
    const title    = result.success
      ? `pause_appliance: ${serviceName} stopped successfully`
      : `pause_appliance: ${serviceName} stop attempted — verification ${result.verificationPass ? 'passed' : 'FAILED'}`;

    createAlert({
      session_id: null,
      severity,
      category:   PAUSE_APPLIANCE_CATEGORY,
      title,
      body:       JSON.stringify({ ...result, stop_issued_at: stopIssuedAt, supervisor: supervisorType }),
      sent_at:    new Date().toISOString(),
      email_to:   null,
    });
  } catch (err) {
    // Never let audit persistence failures surface to the caller.
    log.warn(`pause_appliance: audit record write failed — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Stop the appliance service and verify it is no longer reachable.
 *
 * @returns {Promise<{
 *   success:          boolean,
 *   supervisor:       string,
 *   service_name:     string,
 *   stop_issued_at:   string,
 *   verificationPass: boolean,
 *   health_after:     { reachable: boolean, status_code: number|null, body: object|null },
 *   error?:           string,
 * }>}
 */
async function handler() {
  const { appliance } = getConfig();
  const { type: supervisorType, service_name: serviceName } = appliance.process_supervisor;
  const { base_url, health_endpoint, request_timeout_ms } = appliance.appliance_api;
  const healthUrl  = `${base_url}${health_endpoint}`;
  const httpTimeout = request_timeout_ms ?? 10000;

  const stopIssuedAt = new Date().toISOString();

  log.warn(
    `pause_appliance: issuing stop — supervisor=${supervisorType} service=${serviceName}`
  );

  // ── Issue stop command ────────────────────────────────────────────────────
  try {
    await issueStop(supervisorType, serviceName);
  } catch (err) {
    log.error(`pause_appliance: stop command failed — ${err.message}`);

    const result = {
      success:          false,
      supervisor:       supervisorType,
      service_name:     serviceName,
      stop_issued_at:   stopIssuedAt,
      verificationPass: false,
      health_after:     { reachable: false, status_code: null, body: null },
      error:            err.message,
    };

    _persistAuditRecord(result, supervisorType, serviceName, stopIssuedAt);
    return result;
  }

  // ── Single health check — expect unreachable ──────────────────────────────
  const healthAfter    = await httpGet(healthUrl, httpTimeout);
  const verificationPass = !healthAfter.reachable;

  const result = {
    success:          verificationPass,
    supervisor:       supervisorType,
    service_name:     serviceName,
    stop_issued_at:   stopIssuedAt,
    verificationPass,
    health_after:     healthAfter,
  };

  if (!verificationPass) {
    result.error =
      `Service '${serviceName}' still appears reachable after stop ` +
      `(HTTP ${healthAfter.status_code}).`;
    log.error(`pause_appliance: verification failed — service still reachable`);
  } else {
    log.info(`pause_appliance: service stopped and verified unreachable`);
  }

  _persistAuditRecord(result, supervisorType, serviceName, stopIssuedAt);
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
