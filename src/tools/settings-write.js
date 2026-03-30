'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'settings_write';
const RISK_LEVEL = 'medium';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    key: {
      type:        'string',
      description: 'The station_info key to update.  Must be in the configured allowed_keys list.',
    },
    value: {
      type:        'string',
      description: 'The new string value to store.',
    },
    reason: {
      type:        'string',
      description: 'Optional human-readable reason for the change (logged in the tool result).',
    },
  },
  required: ['key', 'value'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Update a single key in the WeatherStation station_info configuration table. ' +
    'Only keys present in the configured allowed_keys list may be written. ' +
    'Returns the old and new values together with the applied timestamp.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string value for safe embedding in a SQLite single-quoted literal.
 * SQLite's only string-escaping rule is that a single quote is represented
 * by two consecutive single quotes.
 *
 * @param {string} s
 * @returns {string}
 */
function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

/**
 * Build the sqlite3 command for a writable (non-readonly) connection.
 *
 * The SQL is passed via stdin so that no part of the statement is interpreted
 * by the remote shell.
 *
 * @param {string} dbPath
 * @returns {string}
 */
function buildWriteCommand(dbPath) {
  return `sqlite3 "${dbPath.replace(/"/g, '\\"')}"`;
}

/**
 * Build the sqlite3 command for a read-only connection.
 *
 * @param {string} dbPath
 * @returns {string}
 */
function buildReadCommand(dbPath) {
  return `sqlite3 -json -readonly "${dbPath.replace(/"/g, '\\"')}"`;
}

/**
 * Read the current value for `key` from station_info.
 * Returns null when no row exists.
 *
 * @param {string} dbPath
 * @param {string} key - Already validated against the allowlist.
 * @returns {Promise<string|null>}
 */
async function readOldValue(dbPath, key) {
  const sql = `SELECT value FROM station_info WHERE key = '${sqlEscape(key)}'`;
  const { stdout, exitCode, stderr } = await sshBackend.exec(buildReadCommand(dbPath), sql);
  if (exitCode !== 0) {
    throw new Error(`sqlite3 read exited with code ${exitCode}: ${stderr.trim()}`);
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const rows = JSON.parse(trimmed);
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Write `value` for `key` into station_info using INSERT OR REPLACE.
 *
 * @param {string} dbPath
 * @param {string} key   - Already validated against the allowlist.
 * @param {string} value - User-supplied; SQL-escaped before embedding.
 * @returns {Promise<void>}
 */
async function writeValue(dbPath, key, value) {
  const sql =
    `INSERT OR REPLACE INTO station_info (key, value) ` +
    `VALUES ('${sqlEscape(key)}', '${sqlEscape(value)}')`;
  const { exitCode, stderr } = await sshBackend.exec(buildWriteCommand(dbPath), sql);
  if (exitCode !== 0) {
    throw new Error(`sqlite3 write exited with code ${exitCode}: ${stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Update a single station_info key.
 *
 * @param {{ key: string, value: string, reason?: string }} input
 * @returns {Promise<{
 *   success:    boolean,
 *   key:        string,
 *   old_value:  string|null,
 *   new_value:  string,
 *   applied_at: string,
 *   reason?:    string,
 *   error?:     string,
 *   allowed_keys?: string[],
 * }>}
 */
async function handler({ key, value, reason }) {
  const { appliance } = getConfig();
  const dbPath      = appliance.database.path;
  const allowedKeys = appliance.tools?.settings_write?.allowed_keys ?? [];

  // ── AC2: Allowlist check ──────────────────────────────────────────────────
  if (!allowedKeys.includes(key)) {
    return {
      success:      false,
      key,
      old_value:    null,
      new_value:    value,
      applied_at:   new Date().toISOString(),
      error:        `Key '${key}' is not in the allowed_keys list.`,
      allowed_keys: allowedKeys,
    };
  }

  // ── AC3: Read old value ───────────────────────────────────────────────────
  let oldValue;
  try {
    oldValue = await readOldValue(dbPath, key);
  } catch (err) {
    return {
      success:    false,
      key,
      old_value:  null,
      new_value:  value,
      applied_at: new Date().toISOString(),
      error:      `Failed to read current value: ${err.message}`,
    };
  }

  // ── AC4: Write new value ──────────────────────────────────────────────────
  const appliedAt = new Date().toISOString();
  try {
    await writeValue(dbPath, key, value);
  } catch (err) {
    return {
      success:    false,
      key,
      old_value:  oldValue,
      new_value:  value,
      applied_at: appliedAt,
      error:      `Failed to write new value: ${err.message}`,
    };
  }

  // ── AC5: Return result ────────────────────────────────────────────────────
  const result = {
    success:    true,
    key,
    old_value:  oldValue,
    new_value:  value,
    applied_at: appliedAt,
  };
  if (reason != null) result.reason = reason;
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
