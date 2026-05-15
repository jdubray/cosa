'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'unit_health';
const RISK_LEVEL = 'read';

// The four dBOM-required units. Order is the order they appear in the report.
const DEFAULT_UNITS = [
  'baanbaan',
  'baanbaan-ocr',
  'marketing-engine',
  'cloudflared',
];

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
    'Run `systemctl is-active` against each configured systemd unit on the ' +
    'appliance and report each unit\'s state. Distinguishes "active" from ' +
    '"inactive", "failed", "activating", and "unknown" — catches the case ' +
    'where a unit is restart-looping or has stopped entirely. Returns ' +
    'overall_status (\'healthy\' when every unit is active, \'degraded\' ' +
    'otherwise), and a per-unit array with the literal state string.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote-escape a shell argument so it is safe to embed inside a
 * single-quoted bash string.
 *
 * @param {string} value
 * @returns {string}
 */
function shEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/**
 * Build a single SSH command that runs `systemctl is-active` for every unit
 * and prints `<unit>=<state>` lines. Errors are captured in-band so one
 * inactive unit does not cause `set -e` to abort the whole probe.
 *
 * `systemctl is-active` exits non-zero when the unit is not active, so each
 * invocation is wrapped in `|| true` to keep the script going.
 *
 * @param {string[]} units
 * @returns {string}
 */
function buildScript(units) {
  const lines = units.map((u) => {
    const q = `'${shEscape(u)}'`;
    return `STATE=$(systemctl is-active ${q} 2>/dev/null || echo unknown); printf '%s=%s\\n' ${q} "$STATE"`;
  });
  return lines.join('\n');
}

/**
 * Parse `<unit>=<state>\n` lines into an array preserving the input order.
 * Trailing whitespace is trimmed; lines without `=` are ignored.
 *
 * @param {string}   stdout
 * @param {string[]} units - Canonical input order.
 * @returns {Array<{ unit: string, state: string }>}
 */
function parseOutput(stdout, units) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return units.map((u) => ({ unit: u, state: map.get(u) ?? 'unknown' }));
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Check the active state of each configured systemd unit on the appliance.
 *
 * Returns `success: false` (does not throw) on SSH failure so the cron caller
 * can record a degraded result and continue.
 *
 * @returns {Promise<{
 *   success:        boolean,
 *   overall_status: 'healthy' | 'degraded' | 'unreachable',
 *   units:          Array<{ unit: string, state: string, active: boolean }>,
 *   checked_at:     string,
 *   error?:         string,
 * }>}
 */
async function handler() {
  const { appliance } = getConfig();
  const configured = appliance.tools?.unit_health?.units;
  const units = Array.isArray(configured) && configured.length > 0
    ? configured
    : DEFAULT_UNITS;

  const checkedAt = new Date().toISOString();
  const script    = buildScript(units);

  let execResult;
  try {
    execResult = await sshBackend.exec('bash -s', script);
  } catch (err) {
    return {
      success:        false,
      overall_status: 'unreachable',
      units:          units.map((u) => ({ unit: u, state: 'unknown', active: false })),
      checked_at:     checkedAt,
      error:          err.message,
    };
  }

  const { stdout, stderr, exitCode } = execResult;

  if (exitCode !== 0) {
    return {
      success:        false,
      overall_status: 'unreachable',
      units:          units.map((u) => ({ unit: u, state: 'unknown', active: false })),
      checked_at:     checkedAt,
      error:          `unit_health script exited ${exitCode}: ${(stderr ?? '').trim()}`,
    };
  }

  const parsed = parseOutput(stdout, units);
  const enriched = parsed.map((row) => ({
    ...row,
    active: row.state === 'active',
  }));

  const allActive = enriched.every((r) => r.active);
  return {
    success:        true,
    overall_status: allActive ? 'healthy' : 'degraded',
    units:          enriched,
    checked_at:     checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
module.exports._internal = { buildScript, parseOutput, DEFAULT_UNITS };
