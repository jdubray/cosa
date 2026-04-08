'use strict';

const { getConfig }    = require('../config/cosa.config');
const credentialStore  = require('./credential-store');
const { createLogger } = require('./logger');

const log = createLogger('appliance-auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace every `${credential:KEY}` placeholder in a template string with
 * the corresponding value from the credential store.
 *
 * @param {string} template
 * @returns {string}
 * @throws {Error} `code:'CREDENTIAL_NOT_FOUND'` if a referenced key is absent
 *   from the store.  Failing loudly here prevents silent "null" string
 *   interpolation that would cause auth to fail with a misleading 401.
 */
function interpolateCredentials(template) {
  return template.replace(/\$\{credential:([^}]+)\}/g, (_, key) => {
    const value = credentialStore.get(key);
    if (value == null || value === '') {
      const err  = new Error(`Required credential "${key}" is not set in the credential store`);
      err.code   = 'CREDENTIAL_NOT_FOUND';
      throw err;
    }
    return value;
  });
}

/**
 * Parse a token pair from an auth response and persist it to the credential
 * store.  Tries a set of common field names; throws if none is found so
 * that a silently-empty Bearer token is never stored.
 *
 * @param {object} authConfig
 * @param {object} data - Parsed JSON response body
 * @param {'refresh'|'login'} context - Used only in the error message
 * @throws {Error} `code:'APPLIANCE_AUTH_FAILED'` when no token field is found
 */
function _storeTokens(authConfig, data, context) {
  const newAccessToken = data.accessToken ?? data.token ?? data.access_token ?? null;
  if (!newAccessToken) {
    const err  = new Error(
      `Could not extract access token from ${context} response ` +
      '(tried: accessToken, token, access_token)'
    );
    err.code   = 'APPLIANCE_AUTH_FAILED';
    throw err;
  }
  credentialStore.set(authConfig.access_token_credential_key, newAccessToken);

  const newRefreshToken = data.refreshToken ?? data.refresh_token ?? null;
  if (newRefreshToken) {
    credentialStore.set(authConfig.refresh_token_credential_key, newRefreshToken);
  }
}

/**
 * Build auth headers for a single request attempt, reading the current token
 * from the credential store.
 *
 * @param {object} authConfig - `appliance_api.auth` block from appliance.yaml
 * @returns {object} Header map (may be empty for `type: none`)
 */
function buildAuthHeaders(authConfig) {
  const { type } = authConfig;

  if (!type || type === 'none') return {};

  if (type === 'api_key') {
    const key = credentialStore.get(authConfig.api_key_credential_key);
    if (!key) {
      const err  = new Error(`Required credential "${authConfig.api_key_credential_key}" is not set in the credential store`);
      err.code   = 'CREDENTIAL_NOT_FOUND';
      throw err;
    }
    const header = authConfig.api_key_header ?? 'X-API-Key';
    return { [header]: key };
  }

  if (type === 'jwt') {
    const token = credentialStore.get(authConfig.access_token_credential_key);
    return { Authorization: `Bearer ${token}` };
  }

  return {};
}

/**
 * POST to the refresh endpoint and store the new access token.
 *
 * @param {string} baseUrl
 * @param {object} authConfig
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 * @throws {Error} `code:'APPLIANCE_REFRESH_FAILED'` when the server returns 401
 * @throws {Error} `code:'APPLIANCE_AUTH_FAILED'` for any other non-2xx status
 */
async function doRefresh(baseUrl, authConfig, timeoutMs) {
  const body       = interpolateCredentials(authConfig.refresh_body_template);
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${baseUrl}${authConfig.refresh_endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    const err  = new Error('Refresh token rejected — need full re-login');
    err.code   = 'APPLIANCE_REFRESH_FAILED';
    throw err;
  }

  if (!res.ok) {
    const err  = new Error(`Token refresh failed with status ${res.status}`);
    err.code   = 'APPLIANCE_AUTH_FAILED';
    throw err;
  }

  const data = await res.json();
  _storeTokens(authConfig, data, 'refresh');
}

/**
 * POST to the login endpoint and store the returned token pair.
 *
 * @param {string} baseUrl
 * @param {object} authConfig
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 * @throws {Error} `code:'APPLIANCE_AUTH_FAILED'` on any failure
 */
async function doLogin(baseUrl, authConfig, timeoutMs) {
  const body       = interpolateCredentials(authConfig.login_body_template);
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${baseUrl}${authConfig.login_endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err  = new Error(`Login failed with status ${res.status}`);
    err.code   = 'APPLIANCE_AUTH_FAILED';
    throw err;
  }

  const data = await res.json();
  _storeTokens(authConfig, data, 'login');
}

// ---------------------------------------------------------------------------
// Refresh deduplication
// ---------------------------------------------------------------------------

/**
 * In-flight refresh/login Promise, or null when idle.
 *
 * When multiple concurrent requests all receive a 401 at the same time, only
 * the first one triggers a real refresh flow.  All subsequent callers await
 * this same Promise so that:
 *   1. Only one HTTP refresh/login round-trip is made.
 *   2. The first caller's new token is visible to every subsequent retry.
 *   3. The refresh token is never consumed twice (which would fail on
 *      servers that rotate refresh tokens on use).
 *
 * @type {Promise<void> | null}
 */
let _refreshInFlight = null;

/**
 * Ensure a single token refresh/re-login flow is running at a time.
 * Returns the shared Promise, creating it on first call.
 *
 * @param {string} baseUrl
 * @param {object} authConfig
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function _ensureRefresh(baseUrl, authConfig, timeoutMs) {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    try {
      await doRefresh(baseUrl, authConfig, timeoutMs);
    } catch (refreshErr) {
      if (refreshErr.code !== 'APPLIANCE_REFRESH_FAILED') throw refreshErr;
      log.warn('Refresh token rejected — attempting full re-login');
      try {
        await doLogin(baseUrl, authConfig, timeoutMs);
      } catch {
        const err  = new Error('All authentication attempts failed');
        err.code   = 'APPLIANCE_AUTH_FAILED';
        throw err;
      }
    }
  })().finally(() => {
    _refreshInFlight = null;
  });

  return _refreshInFlight;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an authenticated appliance API call.
 *
 * Reads auth configuration from `appliance.yaml` and credentials from the
 * credential store.  On a 401 response the module attempts a token refresh
 * and retries once.  If the refresh token is also expired it falls back to a
 * full re-login.  Throws `APPLIANCE_AUTH_FAILED` only when every strategy has
 * been exhausted.
 *
 * @param {(headers: object) => Promise<{ status: number, body: object|null }>} apiFn
 *   Caller-supplied function that performs the actual HTTP request.  It
 *   receives the current auth headers and must return `{ status, body }`.
 *   Network errors should propagate as thrown exceptions.
 * @returns {Promise<{ status: number, body: object|null }>}
 * @throws {Error} `code:'APPLIANCE_AUTH_FAILED'` – all auth strategies failed
 * @throws {Error} `code:'APPLIANCE_NETWORK_ERROR'` – network / timeout failure
 */
async function withApplianceAuth(apiFn) {
  const { appliance } = getConfig();
  const apiCfg     = appliance.appliance_api ?? {};
  const authConfig = apiCfg.auth;
  const baseUrl    = apiCfg.base_url ?? '';
  const timeoutMs  = apiCfg.request_timeout_ms ?? 10000;

  // No auth configured — pass empty headers.
  if (!authConfig || authConfig.type === 'none' || !authConfig.type) {
    try {
      return await apiFn({});
    } catch (err) {
      const netErr  = new Error(err.message || 'Network error');
      netErr.code   = 'APPLIANCE_NETWORK_ERROR';
      throw netErr;
    }
  }

  // ── Attempt 1: use current stored token ────────────────────────────────────
  let result;
  try {
    result = await apiFn(buildAuthHeaders(authConfig));
  } catch (err) {
    // Credential errors (thrown by buildAuthHeaders before apiFn is called)
    // must propagate as-is — they are configuration problems, not network failures.
    if (err.code === 'CREDENTIAL_NOT_FOUND') throw err;
    const netErr  = new Error(err.message || 'Network error');
    netErr.code   = 'APPLIANCE_NETWORK_ERROR';
    throw netErr;
  }

  if (result.status !== 401) return result;

  // ── 401: API-key auth cannot refresh — fail immediately ───────────────────
  if (authConfig.type === 'api_key') {
    const err  = new Error('API key rejected (401)');
    err.code   = 'APPLIANCE_AUTH_FAILED';
    throw err;
  }

  // ── JWT: attempt refresh (deduplicated across concurrent callers) ──────────
  log.warn('Received 401 — attempting token refresh');
  await _ensureRefresh(baseUrl, authConfig, timeoutMs);

  // ── Attempt 2: retry with new token ───────────────────────────────────────
  try {
    return await apiFn(buildAuthHeaders(authConfig));
  } catch (err) {
    if (err.code === 'CREDENTIAL_NOT_FOUND') throw err;
    const netErr  = new Error(err.message || 'Network error');
    netErr.code   = 'APPLIANCE_NETWORK_ERROR';
    throw netErr;
  }
}

module.exports = { withApplianceAuth, interpolateCredentials };
