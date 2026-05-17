'use strict';

const { getConfig }    = require('../../config/cosa.config');
const sshBackend       = require('../ssh-backend');
const { createLogger } = require('../logger');

const log = createLogger('webhook-hmac-verify');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'webhook_hmac_verify';
const RISK_LEVEL = 'read';

// The appliance bun service is loopback-only (127.0.0.1:3000) by design, so
// the probe cannot reach it from the LAN — it must be executed on the
// appliance itself via SSH. See docs/baanbaan_tools.md for the API surface.
const DEFAULT_LOOPBACK_BASE = 'http://127.0.0.1:3000';
const DEFAULT_PATH_TEMPLATE = '/webhooks/generic/{merchantId}';
const DEFAULT_MERCHANT_DB   = '/home/baanbaan/baan-baan-merchant/v2/data/merchant.db';

// Deliberately bogus signature: wrong hex content, right header format.
const INVALID_SIGNATURE = 'sha256=00000000000000000000000000000000cosa-probe-invalid';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Verify that the POS webhook endpoint rejects requests carrying an ' +
    'invalid HMAC signature. Executes a curl on the appliance over SSH ' +
    '(the API is loopback-only and unreachable from the LAN by design). ' +
    'Returns verified: true if the endpoint responds with HTTP 401 (probe ' +
    'rejected), verified: false with severity: critical on HTTP 200 ' +
    '(unsigned webhook accepted), and verified: false with severity: null ' +
    'on any other status.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function shEscape(value) {
  return String(value).replace(/'/g, "'\\''");
}

/**
 * Pull a usable merchant id off the appliance. Prefer one with a configured
 * webhook secret (so the probe exercises the HMAC compare path); fall back to
 * any merchant otherwise (rejection still happens, one guard earlier).
 *
 * @param {string} dbPath
 * @returns {Promise<string|null>}
 */
async function resolveMerchantId(dbPath) {
  const qDb = `'${shEscape(dbPath)}'`;
  const cmd =
    `sqlite3 -readonly ${qDb} ` +
    `"SELECT id FROM merchants WHERE webhook_secret_enc IS NOT NULL ORDER BY id LIMIT 1; ` +
    `SELECT id FROM merchants ORDER BY id LIMIT 1"`;

  let result;
  try {
    result = await sshBackend.exec(cmd);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines[0] ?? null;
}

/**
 * Build the loopback probe script. Prints a single KEY=VALUE block so the
 * caller can parse the outcome without ambiguity.
 *
 * @param {string} url
 * @returns {string}
 */
function buildScript(url) {
  const qUrl = `'${shEscape(url)}'`;
  const qSig = `'${shEscape(INVALID_SIGNATURE)}'`;
  return [
    'set -u',
    '',
    `OUT=$(curl -sS --max-time 5 -o /dev/null -w "HTTP_CODE=%{http_code}\\nCURL_EXIT=%{exitcode}\\n" \\`,
    `  -X POST ${qUrl} \\`,
    `  -H "X-Webhook-Signature: ${qSig}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"event":"cosa.hmac.probe"}' 2>&1) || true`,
    'printf "%s\\n" "$OUT"',
  ].join('\n');
}

function parseOutput(stdout) {
  const result = { http_code: null, curl_exit: null };
  for (const line of stdout.split('\n').map((s) => s.trim())) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'HTTP_CODE') result.http_code = parseInt(m[2], 10);
    if (m[1] === 'CURL_EXIT') result.curl_exit = parseInt(m[2], 10);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   verified:    boolean,
 *   status_code: number | null,
 *   severity:    'critical' | null,
 *   endpoint:    string,
 *   message:     string,
 *   checked_at:  string,
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();
  const { appliance } = getConfig();
  const toolCfg = appliance.tools?.webhook_hmac_verify ?? {};

  const loopbackBase = toolCfg.internal_base_url ?? DEFAULT_LOOPBACK_BASE;
  const pathTemplate = toolCfg.path_template    ?? DEFAULT_PATH_TEMPLATE;
  const merchantDb   = toolCfg.merchant_db_path ?? DEFAULT_MERCHANT_DB;

  let merchantId = toolCfg.merchant_id ?? null;
  if (!merchantId) {
    merchantId = await resolveMerchantId(merchantDb);
  }
  if (!merchantId) {
    const message = `Could not resolve a merchant id for the probe (db: ${merchantDb}).`;
    log.warn(message);
    return {
      verified:    false,
      status_code: null,
      severity:    null,
      endpoint:    `${loopbackBase}${pathTemplate}`,
      message,
      checked_at,
    };
  }

  const endpoint = `${loopbackBase}${pathTemplate.replace('{merchantId}', merchantId)}`;
  log.info(`Probing HMAC enforcement at ${endpoint} (via SSH loopback)`);

  let execResult;
  try {
    execResult = await sshBackend.exec('bash -s', buildScript(endpoint));
  } catch (err) {
    const message = `SSH probe failed: ${err.message}`;
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

  if (execResult.exitCode !== 0) {
    const message = `SSH probe script exited ${execResult.exitCode}: ${(execResult.stderr || '').trim()}`;
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

  const { http_code, curl_exit } = parseOutput(execResult.stdout || '');

  // curl couldn't reach the endpoint (loopback service down, etc.)
  if (curl_exit !== 0 || http_code === null || http_code === 0) {
    const message =
      `Endpoint unreachable from appliance loopback: ` +
      `curl exit=${curl_exit}, http_code=${http_code}.`;
    log.warn(message);
    return {
      verified:    false,
      status_code: http_code,
      severity:    null,
      endpoint,
      message,
      checked_at,
    };
  }

  if (http_code === 401) {
    const message = 'HMAC signature validation is active: probe request rejected with 401.';
    log.info(message);
    return {
      verified:    true,
      status_code: http_code,
      severity:    null,
      endpoint,
      message,
      checked_at,
    };
  }

  if (http_code === 200) {
    const message =
      'CRITICAL: HMAC signature validation is NOT enforced. ' +
      'The webhook endpoint accepted a request with an invalid signature (HTTP 200). ' +
      'Webhook spoofing is possible.';
    log.error(message);
    return {
      verified:    false,
      status_code: http_code,
      severity:    'critical',
      endpoint,
      message,
      checked_at,
    };
  }

  const message =
    `Inconclusive: endpoint returned HTTP ${http_code}. ` +
    'Expected 401 (HMAC enforced) or 200 (HMAC absent). Manual review required.';
  log.warn(message);
  return {
    verified:    false,
    status_code: http_code,
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
