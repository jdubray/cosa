'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = 'health_check';
const RISK_LEVEL = 'read';

/** JSON Schema for tool inputs — no parameters needed. */
const INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

/** Full tool schema passed to tool-registry.register(). */
const SCHEMA = {
  description:
    'Run a comprehensive health check against the Baanbaan appliance. ' +
    'Checks SSH connectivity, HTTP health endpoints (/health and /health/ready), ' +
    'and the systemd process supervisor. Returns overall_status of ' +
    "'healthy', 'degraded', or 'unreachable'.",
  inputSchema: INPUT_SCHEMA,
};

/**
 * Build the systemctl show command for the configured service name.
 * Constructed at call time (not module load) so config changes are picked up.
 *
 * @returns {string}
 */
function buildSystemctlCmd() {
  const { appliance } = getConfig();
  const serviceName   = appliance.process_supervisor?.service_name ?? 'baanbaan';
  return `systemctl show ${serviceName} --property=ActiveState,SubState,ExecMainStartTimestamp,NRestarts`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Poll `sshBackend.isConnected()` up to three times with a 2-second delay
 * between each attempt.  Returns `true` as soon as a connection is confirmed,
 * `false` if all retries are exhausted.
 *
 * The SSH backend runs its own reconnect loop — this function only waits for
 * it to succeed; it does not initiate a new connection itself.
 *
 * @param {(ms: number) => Promise<void>} [delay] - Injectable sleep for tests.
 * @returns {Promise<boolean>}
 */
async function ensureSshConnected(delay = (ms) => new Promise((r) => setTimeout(r, ms))) {
  if (sshBackend.isConnected()) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(2000);
    if (sshBackend.isConnected()) return true;
  }
  return false;
}

/**
 * Perform a direct LAN HTTP GET with a hard timeout enforced via AbortController.
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
    try { body = await res.json(); } catch { /* non-JSON body — leave null */ }
    return { reachable: true, status_code: res.status, body };
  } catch {
    clearTimeout(timer);
    return { reachable: false, status_code: null, body: null };
  }
}

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
 * Convert a systemd `ExecMainStartTimestamp` value to an ISO 8601 string and
 * compute `uptime_seconds` relative to the current clock.
 *
 * systemd timestamp format: `Mon 2024-01-15 10:30:00 UTC`
 * The leading day-of-week token is stripped before parsing.
 *
 * @param {string} timestamp - Raw value from systemd (may be empty string).
 * @returns {{ isoString: string|null, uptimeSeconds: number|null }}
 */
function parseStartTimestamp(timestamp) {
  if (!timestamp) return { isoString: null, uptimeSeconds: null };

  // Strip optional leading day-of-week abbreviation ("Mon ", "Tue ", …)
  const cleaned = timestamp.replace(/^[A-Za-z]{3}\s+/, '');
  const parsed  = new Date(cleaned);
  if (isNaN(parsed.getTime())) return { isoString: null, uptimeSeconds: null };

  return {
    isoString:     parsed.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - parsed.getTime()) / 1000),
  };
}

/**
 * Determine overall_status from individual check results.
 *
 * Rules (evaluated in order):
 * 1. `unreachable` — SSH not connected, or (when http_check is enabled) either
 *                    HTTP endpoint is unreachable.
 * 2. `healthy`     — SSH up + (http_check enabled → both endpoints return 200)
 *                    + process is active/running with zero restarts.
 * 3. `degraded`    — Everything reachable, but at least one check is not ideal.
 *
 * @param {{
 *   sshConnected:    boolean,
 *   httpCheckEnabled: boolean,
 *   httpHealth: { reachable: boolean, status_code: number|null, body: object|null },
 *   httpReady:  { reachable: boolean, status_code: number|null, body: object|null },
 *   procInfo:   object|null
 * }} checks
 * @returns {'healthy'|'degraded'|'unreachable'}
 */
function determineOverallStatus({ sshConnected, httpCheckEnabled, httpHealth, httpReady, procInfo }) {
  if (!sshConnected) return 'unreachable';
  if (httpCheckEnabled && (httpHealth.reachable === false || httpReady.reachable === false)) {
    return 'unreachable';
  }

  const httpHealthOk = !httpCheckEnabled ||
    (httpHealth.status_code === 200 && httpHealth.body !== null);
  const httpReadyOk  = !httpCheckEnabled ||
    (httpReady.status_code === 200 && httpReady.body !== null);
  const processOk =
    procInfo !== null &&
    procInfo.active_state === 'active' &&
    procInfo.sub_state   === 'running' &&
    procInfo.restarts    === 0;

  if (httpHealthOk && httpReadyOk && processOk) return 'healthy';
  return 'degraded';
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Run a comprehensive health check against the Baanbaan appliance.
 *
 * Execution order:
 *   Step 1 (prerequisite): SSH connectivity — up to 3 retries with 2 s backoff.
 *   Steps 2 + 3 (parallel): HTTP GET /health and HTTP GET /health/ready.
 *   Step 4 (SSH-dependent): `systemctl show` via SSH.
 *
 * @returns {Promise<{
 *   overall_status: 'healthy'|'degraded'|'unreachable',
 *   ssh_connected:  boolean,
 *   http_health:    object,
 *   http_ready:     object,
 *   process:        object|null,
 *   errors:         string[],
 *   checked_at:     string
 * }>}
 */
async function handler() {
  const { appliance }  = getConfig();
  const { base_url, health_endpoint, health_ready_endpoint, request_timeout_ms } =
    appliance.appliance_api;
  const timeoutMs       = request_timeout_ms ?? 10000;
  const checkedAt       = new Date().toISOString();
  const errors          = [];
  const httpCheckEnabled = appliance.tools?.health_check?.http_check !== false;

  // ── Step 1: SSH connectivity ──────────────────────────────────────────────
  const sshConnected = await ensureSshConnected();
  if (!sshConnected) errors.push('SSH not connected after 3 retries');

  // ── Steps 2 & 3: HTTP health checks (parallel, skipped when disabled) ────
  const SKIPPED = { reachable: null, status_code: null, body: null, skipped: true };
  const [httpHealth, httpReady] = httpCheckEnabled
    ? await Promise.all([
        httpGet(`${base_url}${health_endpoint}`,      timeoutMs),
        httpGet(`${base_url}${health_ready_endpoint}`, timeoutMs),
      ])
    : [SKIPPED, SKIPPED];

  if (httpCheckEnabled && !httpHealth.reachable) errors.push(`HTTP ${health_endpoint} unreachable`);
  if (httpCheckEnabled && !httpReady.reachable)  errors.push(`HTTP ${health_ready_endpoint} unreachable`);

  // ── Step 4: Process supervisor (SSH-dependent) ────────────────────────────
  let procInfo = null;
  if (sshConnected) {
    try {
      const { stdout } = await sshBackend.exec(buildSystemctlCmd());
      const props      = parseSystemctlOutput(stdout);
      const { isoString, uptimeSeconds } = parseStartTimestamp(
        props.ExecMainStartTimestamp ?? ''
      );

      const restarts = props.NRestarts != null
        ? parseInt(props.NRestarts, 10)
        : null;

      procInfo = {
        running:         props.ActiveState === 'active' && props.SubState === 'running',
        active_state:    props.ActiveState  ?? null,
        sub_state:       props.SubState     ?? null,
        started_at:      isoString,
        uptime_seconds:  uptimeSeconds,
        restarts,
      };

      if (!procInfo.running) {
        errors.push(
          `systemd unit not running: ActiveState=${procInfo.active_state} SubState=${procInfo.sub_state}`
        );
      }
      if (restarts !== null && restarts > 0) {
        errors.push(`systemd unit has restarted ${restarts} time(s)`);
      }
    } catch (err) {
      errors.push(`Process supervisor check failed: ${err.message}`);
    }
  }

  // ── Status determination ──────────────────────────────────────────────────
  const overallStatus = determineOverallStatus({ sshConnected, httpCheckEnabled, httpHealth, httpReady, procInfo });

  return {
    overall_status: overallStatus,
    ssh_connected:  sshConnected,
    http_health:    httpHealth,
    http_ready:     httpReady,
    process:        procInfo,
    errors,
    checked_at:     checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
