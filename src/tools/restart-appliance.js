'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'restart_appliance';
const RISK_LEVEL = 'high';

const DEFAULT_GRACEFUL_TIMEOUT_S = 60;
const POLL_INTERVAL_MS           = 2000;

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
    'Issue a graceful systemd service restart on the WeatherStation appliance, ' +
    'then poll GET /health/ready every 2 seconds until the service is healthy or ' +
    'the graceful_timeout_seconds is exceeded.  Returns the pre-restart uptime, ' +
    'the came_up_at timestamp, and the final health endpoint response.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers — systemctl
// ---------------------------------------------------------------------------

/**
 * Parse `systemctl show` key=value output into a plain object.
 *
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
function parseSystemctlOutput(stdout) {
  const result = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

/**
 * Derive uptime in milliseconds from a systemd `ExecMainStartTimestamp` value.
 *
 * systemd format: `Mon 2024-01-15 10:30:00 UTC` — leading day-of-week stripped.
 *
 * @param {string} timestamp - Raw value (may be empty).
 * @returns {number|null}
 */
function uptimeMsFromTimestamp(timestamp) {
  if (!timestamp) return null;
  const cleaned = timestamp.replace(/^[A-Za-z]{3}\s+/, '');
  const parsed  = new Date(cleaned);
  if (isNaN(parsed.getTime())) return null;
  return Date.now() - parsed.getTime();
}

/**
 * Fetch the current service uptime in milliseconds via `systemctl show`.
 * Returns null on any failure (non-zero exit, parse error, SSH error).
 *
 * @param {string} serviceName
 * @returns {Promise<number|null>}
 */
async function fetchUptimeMs(serviceName) {
  const cmd = `systemctl show ${serviceName} --property=ExecMainStartTimestamp`;
  try {
    const { stdout, exitCode } = await sshBackend.exec(cmd);
    if (exitCode !== 0) return null;
    const props = parseSystemctlOutput(stdout);
    return uptimeMsFromTimestamp(props.ExecMainStartTimestamp ?? '');
  } catch {
    return null;
  }
}

/**
 * Issue `systemctl restart <serviceName>` via SSH.
 *
 * @param {string} serviceName
 * @returns {Promise<void>}
 * @throws {Error} if the command exits non-zero.
 */
async function issueRestart(serviceName) {
  const { exitCode, stderr } = await sshBackend.exec(`systemctl restart ${serviceName}`);
  if (exitCode !== 0) {
    throw new Error(
      `systemctl restart exited with code ${exitCode}: ${stderr.trim()}`
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — health polling
// ---------------------------------------------------------------------------

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
 * Sleep for `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll GET /health/ready every `POLL_INTERVAL_MS` until the endpoint returns
 * HTTP 200 or the deadline is reached.
 *
 * @param {string} readyUrl    - Full URL for the readiness endpoint.
 * @param {number} timeoutMs   - Maximum polling duration in milliseconds.
 * @param {number} httpTimeout - Per-request HTTP timeout in milliseconds.
 * @returns {Promise<{
 *   healthy:     boolean,
 *   came_up_at:  string|null,
 *   health_after: { reachable: boolean, status_code: number|null, body: object|null },
 * }>}
 */
async function pollUntilReady(readyUrl, timeoutMs, httpTimeout) {
  const deadline = Date.now() + timeoutMs;
  let lastCheck  = { reachable: false, status_code: null, body: null };

  while (Date.now() < deadline) {
    lastCheck = await httpGet(readyUrl, httpTimeout);
    if (lastCheck.reachable && lastCheck.status_code === 200) {
      return {
        healthy:      true,
        came_up_at:   new Date().toISOString(),
        health_after: lastCheck,
      };
    }
    // Wait before next attempt, but stop immediately if deadline has passed.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return {
    healthy:      false,
    came_up_at:   null,
    health_after: lastCheck,
  };
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Gracefully restart the WeatherStation systemd service and wait for it to
 * become healthy.
 *
 * @returns {Promise<{
 *   success:            boolean,
 *   service_name:       string,
 *   restart_issued_at:  string,
 *   came_up_at:         string|null,
 *   uptime_before_ms:   number|null,
 *   health_after:       { reachable: boolean, status_code: number|null, body: object|null },
 *   error?:             string,
 * }>}
 */
async function handler() {
  const { appliance } = getConfig();
  const serviceName    = appliance.process_supervisor.service_name;
  const { base_url, health_ready_endpoint, request_timeout_ms } = appliance.appliance_api;
  const readyUrl       = `${base_url}${health_ready_endpoint}`;
  const httpTimeout    = request_timeout_ms ?? 10000;
  const gracefulMs     =
    (appliance.tools?.restart_appliance?.graceful_timeout_seconds ?? DEFAULT_GRACEFUL_TIMEOUT_S)
    * 1000;

  // ── AC1: Capture uptime before restart ───────────────────────────────────
  const uptimeBeforeMs = await fetchUptimeMs(serviceName);

  // ── AC2: Issue restart ────────────────────────────────────────────────────
  const restartIssuedAt = new Date().toISOString();
  try {
    await issueRestart(serviceName);
  } catch (err) {
    return {
      success:           false,
      service_name:      serviceName,
      restart_issued_at: restartIssuedAt,
      came_up_at:        null,
      uptime_before_ms:  uptimeBeforeMs,
      health_after:      { reachable: false, status_code: null, body: null },
      error:             err.message,
    };
  }

  // ── AC3: Poll /health/ready ───────────────────────────────────────────────
  const { healthy, came_up_at, health_after } =
    await pollUntilReady(readyUrl, gracefulMs, httpTimeout);

  // ── AC4 + AC5: Build result ───────────────────────────────────────────────
  const result = {
    success:           healthy,
    service_name:      serviceName,
    restart_issued_at: restartIssuedAt,
    came_up_at,
    uptime_before_ms:  uptimeBeforeMs,
    health_after,
  };

  if (!healthy) {
    result.error =
      `Service did not become healthy within ${gracefulMs / 1000}s of restart.`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
