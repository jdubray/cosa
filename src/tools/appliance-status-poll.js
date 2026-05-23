'use strict';

const { getConfig }          = require('../../config/cosa.config');
const { withApplianceAuth }  = require('../appliance-auth');
const watcherRegistry        = require('../watcher-registry');
const { createAlert }        = require('../session-store');
const { createLogger }       = require('../logger');
const sshBackend             = require('../ssh-backend');
const { shEscape }           = require('../shell-utils');

const WATCHER_ERROR_CATEGORY = 'watcher_error';

const log = createLogger('appliance-status-poll');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'appliance_status_poll';
const RISK_LEVEL = 'read';

const SCHEMA = {
  description:
    'Fetch a live status snapshot from the appliance status endpoint and run ' +
    'all registered condition watchers against it. Returns the raw status and ' +
    'any alerts that fired. Use to check appliance health or trigger monitoring.',
  inputSchema: {
    type: 'object',
    properties: {
      skip_watchers: {
        type: 'boolean',
        description:
          'If true, fetch the snapshot but do not run watchers. ' +
          'Useful when Claude needs to inspect the status schema (e.g. to create a new watcher).',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated GET to the appliance status endpoint via SSH loopback.
 *
 * /api/status is blocked at the Cloudflare tunnel level — it is only reachable
 * from the appliance's own loopback (127.0.0.1:3000). We run curl on the appliance
 * over SSH so the request originates from localhost.
 *
 * @param {string} endpoint  e.g. '/api/status'
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: object|null }>}
 */
async function fetchStatus(endpoint, timeoutMs) {
  const toolCfg      = getConfig().appliance?.appliance_api ?? {};
  const internalBase = toolCfg.internal_base_url ?? 'http://127.0.0.1:3000';
  const url          = `${internalBase}${endpoint}`;
  const curlTimeout  = Math.max(1, Math.ceil(Number(timeoutMs) / 1000)) || 10;

  return withApplianceAuth(async (authHeaders) => {
    const bearer    = authHeaders.Authorization ?? '';
    // Defense-in-depth: escape interpolated values so the single-quoted
    // curl args are safe regardless of token/url content (2026-05-22).
    const headerArg = shEscape(`Authorization: ${bearer}`);
    const safeUrl   = shEscape(url);
    const cmd    = `curl -sS --max-time ${curlTimeout} -w '\nHTTP_STATUS=%{http_code}' -H '${headerArg}' '${safeUrl}'`;

    let result;
    try {
      result = await sshBackend.exec(cmd);
    } catch (err) {
      const netErr = new Error(err.message || 'SSH exec failed');
      netErr.code  = 'APPLIANCE_NETWORK_ERROR';
      throw netErr;
    }

    const lines      = (result.stdout ?? '').split('\n');
    const statusLine = lines.find(l => l.startsWith('HTTP_STATUS='));
    if (!statusLine) {
      // curl resolved but emitted no status line: connection refused or
      // --max-time kill. Surface as a network error instead of masking it
      // as 200 with a null body (which watchers would then evaluate).
      const netErr = new Error('curl emitted no HTTP_STATUS line — appliance unreachable or curl failed');
      netErr.code  = 'APPLIANCE_NETWORK_ERROR';
      throw netErr;
    }
    const httpStatus = parseInt(statusLine.replace('HTTP_STATUS=', ''), 10);
    const bodyStr    = lines.filter(l => !l.startsWith('HTTP_STATUS=')).join('\n').trim();

    let body = null;
    try { body = JSON.parse(bodyStr); } catch { /* non-JSON body */ }

    return { status: httpStatus, body };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ skip_watchers?: boolean }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  const polledAt = new Date().toISOString();
  const { appliance } = getConfig();
  const apiCfg   = appliance.appliance_api ?? {};
  const baseUrl  = apiCfg.base_url         ?? '';
  const endpoint = apiCfg.status_endpoint  ?? '/api/status';
  const timeout  = apiCfg.request_timeout_ms ?? 10000;

  // ── 1. Fetch snapshot ──────────────────────────────────────────────────────
  let httpResult;
  try {
    httpResult = await fetchStatus(endpoint, timeout);
  } catch (err) {
    log.warn(`Status poll failed: ${err.message} (code=${err.code})`);
    return {
      success:    false,
      snapshot:   null,
      alerts:     [],
      error:      err.message,
      code:       err.code ?? 'APPLIANCE_NETWORK_ERROR',
      polled_at:  polledAt,
    };
  }

  if (httpResult.status < 200 || httpResult.status >= 300) {
    return {
      success:    false,
      snapshot:   null,
      alerts:     [],
      error:      `Appliance returned ${httpResult.status}`,
      code:       'APPLIANCE_HTTP_ERROR',
      status_code: httpResult.status,
      polled_at:  polledAt,
    };
  }

  const snapshot = httpResult.body;

  // ── 2. Optionally run watchers ────────────────────────────────────────────
  if (input.skip_watchers) {
    return {
      success:      true,
      snapshot,
      alerts:       [],
      watchers_run: 0,
      polled_at:    polledAt,
    };
  }

  const { alerts, errors, watchers_evaluated } = await watcherRegistry.runAll(snapshot);

  if (errors.length > 0) {
    log.warn(`${errors.length} watcher(s) threw errors during poll`);

    // Persist each watcher error as an alert so it shows up in historical
    // alert queries and is not silently lost after the session closes.
    for (const e of errors) {
      try {
        createAlert({
          session_id: null,
          severity:   'warning',
          category:   WATCHER_ERROR_CATEGORY,
          title:      `Watcher "${e.watcher_id}" threw an error during poll`,
          body:       JSON.stringify({ watcher_id: e.watcher_id, error: e.error, polled_at: polledAt }),
        });
      } catch (dbErr) {
        log.warn(`Failed to persist watcher error alert: ${dbErr.message}`);
      }
    }
  }

  log.info(
    `Poll complete — ${watchers_evaluated} watcher(s) evaluated, ` +
    `${alerts.length} alert(s), ${errors.length} error(s)`
  );

  return {
    success:      true,
    snapshot,
    alerts,
    watchers_run: watchers_evaluated,
    ...(errors.length > 0 && { watchers_errored: errors }),
    polled_at:    polledAt,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  name:      NAME,
  schema:    SCHEMA,
  handler,
  riskLevel: RISK_LEVEL,
};
