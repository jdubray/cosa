'use strict';

const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('webhook-hmac-verify');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'webhook_hmac_verify';
const RISK_LEVEL = 'read';

/**
 * Deliberately invalid HMAC signature sent with the probe request.
 * It is obviously bogus (wrong format and wrong value) so a correct
 * implementation will always reject it with HTTP 401.
 */
const INVALID_SIGNATURE = 'sha256=00000000000000000000000000000000cosa-probe-invalid';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Verify that HMAC signature validation is enforced on the POS webhook ' +
    'endpoint. Sends a POST request with a deliberately invalid X-Signature ' +
    'header to the configured webhook endpoint. Returns verified: true if the ' +
    'server responds with HTTP 401 (signature rejected), or verified: false ' +
    'with severity critical if it responds with HTTP 200 (HMAC not enforced). ' +
    'Risk level: read (passive probe, no state mutation).',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * POST to `url` with a single JSON body and the given headers.
 * Hard-times out after `timeoutMs` milliseconds.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<{ reachable: boolean, statusCode: number|null, error: string|null }>}
 */
async function httpPost(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    return { reachable: true, statusCode: res.status, error: null };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      reachable:  false,
      statusCode: null,
      error:      isTimeout ? `Request timed out after ${timeoutMs} ms` : err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   verified:     boolean,
 *   status_code:  number | null,
 *   severity:     'critical' | null,
 *   endpoint:     string,
 *   message:      string,
 *   checked_at:   string
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();
  const { appliance } = getConfig();

  const baseUrl    = appliance.appliance_api.base_url;
  const timeoutMs  = appliance.appliance_api.request_timeout_ms ?? 10000;

  const webhookPath = appliance.tools?.webhook_hmac_verify?.endpoint
    ?? '/api/webhooks/pos/test-merchant';

  const endpoint = `${baseUrl}${webhookPath}`;

  log.info(`Probing HMAC enforcement at ${endpoint}`);

  const { reachable, statusCode, error } = await httpPost(
    endpoint,
    { 'X-Signature': INVALID_SIGNATURE },
    { event: 'cosa.hmac.probe', timestamp: checked_at },
    timeoutMs
  );

  // ── Unreachable ────────────────────────────────────────────────────────────
  if (!reachable) {
    const message = `Endpoint unreachable: ${error}`;
    log.warn(message);
    return {
      verified:    false,
      status_code: null,
      severity:    null,
      endpoint,
      message,
      checked_at,
    };
  }

  // ── HTTP 401 — HMAC enforcement active ────────────────────────────────────
  if (statusCode === 401) {
    const message = 'HMAC signature validation is active: probe request rejected with 401.';
    log.info(message);
    return {
      verified:    true,
      status_code: statusCode,
      severity:    null,
      endpoint,
      message,
      checked_at,
    };
  }

  // ── HTTP 200 — HMAC NOT enforced ──────────────────────────────────────────
  if (statusCode === 200) {
    const message =
      'CRITICAL: HMAC signature validation is NOT enforced. ' +
      'The webhook endpoint accepted a request with an invalid signature (HTTP 200). ' +
      'Webhook spoofing is possible.';
    log.error(message);
    return {
      verified:    false,
      status_code: statusCode,
      severity:    'critical',
      endpoint,
      message,
      checked_at,
    };
  }

  // ── Any other status code — inconclusive ──────────────────────────────────
  const message =
    `Inconclusive: endpoint returned HTTP ${statusCode}. ` +
    'Expected 401 (HMAC enforced) or 200 (HMAC absent). Manual review required.';
  log.warn(message);
  return {
    verified:    false,
    status_code: statusCode,
    severity:    null,
    endpoint,
    message,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
