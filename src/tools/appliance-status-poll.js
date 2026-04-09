'use strict';

const { getConfig }          = require('../../config/cosa.config');
const { withApplianceAuth }  = require('../appliance-auth');
const watcherRegistry        = require('../watcher-registry');
const { createAlert }        = require('../session-store');
const { createLogger }       = require('../logger');

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
 * Perform an authenticated GET to the appliance status endpoint.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: object|null }>}
 */
async function fetchStatus(url, timeoutMs) {
  return withApplianceAuth(async (authHeaders) => {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res  = await fetch(url, {
        method:  'GET',
        headers: { ...authHeaders },
        signal:  controller.signal,
      });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body — leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
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

  const url = `${baseUrl}${endpoint}`;

  // ── 1. Fetch snapshot ──────────────────────────────────────────────────────
  let httpResult;
  try {
    httpResult = await fetchStatus(url, timeout);
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
