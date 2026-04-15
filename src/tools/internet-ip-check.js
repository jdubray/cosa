'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'internet_ip_check';
const RISK_LEVEL = 'read';

/** Public-IP detection endpoint — returns JSON: { "ip": "x.x.x.x" } */
const IP_SERVICE_URL  = 'https://api.ipify.org?format=json';
const REQUEST_TIMEOUT = 10_000; // ms

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Check whether the internet is reachable and return the current public-facing IP address. ' +
    'Queries api.ipify.org with a 10-second timeout. ' +
    'Returns internetUp (boolean), publicIp (string or null), and checkedAt (ISO timestamp).',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   internetUp: boolean,
 *   publicIp:   string | null,
 *   checkedAt:  string,
 * }>}
 */
async function handler() {
  const checkedAt  = new Date().toISOString();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(IP_SERVICE_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return { internetUp: false, publicIp: null, checkedAt };
    }

    const data = await res.json();
    const ip   = typeof data.ip === 'string' ? data.ip.trim() : null;

    return { internetUp: !!ip, publicIp: ip, checkedAt };
  } catch {
    clearTimeout(timer);
    return { internetUp: false, publicIp: null, checkedAt };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
