'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME        = 'db_query';
const RISK_LEVEL  = 'read';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

/**
 * SQL keywords whose presence in a query string indicates a destructive,
 * schema-modifying, or information-leaking operation.  Each is tested as a
 * full word (word-boundary anchored) so that column names like `drop_count`
 * are not false-positives.
 *
 * PRAGMA is included because it can expose schema internals and change
 * database settings (e.g. `PRAGMA writable_schema=ON`).
 */
const DESTRUCTIVE_KEYWORDS = [
  'DROP', 'DELETE', 'UPDATE', 'INSERT', 'CREATE', 'ALTER', 'ATTACH', 'PRAGMA',
];

/** Pre-compiled case-insensitive regex for the whole set. */
const DESTRUCTIVE_RE = new RegExp(
  `\\b(${DESTRUCTIVE_KEYWORDS.join('|')})\\b`,
  'i'
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'A SQL SELECT statement to run against the Baanbaan database. ' +
        'Must start with SELECT. DML and DDL keywords are not allowed.',
    },
    limit: {
      type:        'integer',
      default:     DEFAULT_LIMIT,
      maximum:     MAX_LIMIT,
      minimum:     1,
      description: 'Maximum number of rows to return (default 50, max 100).',
    },
  },
  required: ['query'],
};

const SCHEMA = {
  description:
    'Execute a read-only SQL SELECT statement against the Baanbaan SQLite ' +
    'database via SSH.  Returns the matching rows together with metadata ' +
    '(row_count, truncated, query_time_ms).',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `query` is a safe read-only SELECT statement.
 *
 * Rules (applied in order):
 * 1. The first token (after trimming) must be `SELECT` (case-insensitive).
 * 2. The query must not contain a semicolon — semicolons introduce additional
 *    SQL statements that the sqlite3 CLI will execute in sequence, bypassing
 *    the single-statement constraint enforced by this validator.
 * 3. The query must not contain any word-boundary-anchored destructive keyword
 *    (DROP, DELETE, UPDATE, INSERT, CREATE, ALTER, ATTACH, PRAGMA).
 *
 * @param {string} query
 * @throws {Error} with a descriptive message if validation fails.
 */
function validateQuery(query) {
  const trimmed    = query.trim();
  const firstToken = trimmed.split(/\s+/)[0].toUpperCase();

  if (firstToken !== 'SELECT') {
    throw new Error(
      `Query must start with SELECT (got "${firstToken}"). ` +
      'Only read-only SELECT statements are allowed.'
    );
  }

  if (trimmed.includes(';')) {
    throw new Error(
      'Multi-statement queries are not allowed. ' +
      'Remove the semicolon and send one SELECT statement at a time.'
    );
  }

  const match = DESTRUCTIVE_RE.exec(trimmed);
  if (match) {
    throw new Error(
      `Query contains forbidden keyword "${match[1].toUpperCase()}". ` +
      'Only read-only SELECT statements are allowed.'
    );
  }
}

/**
 * Append `LIMIT {limit}` to the query if no LIMIT clause is already present.
 *
 * @param {string} query - Already-validated SELECT statement.
 * @param {number} limit
 * @returns {string}
 */
function applyLimit(query, limit) {
  if (/\bLIMIT\b/i.test(query)) return query;
  return `${query.trimEnd()} LIMIT ${limit}`;
}

/**
 * Build the sqlite3 SSH command string.
 *
 * The SQL query is NOT embedded in the command string.  It is passed via
 * stdin (see `sshBackend.exec` second argument) so that shell metacharacters
 * in the query — `$(...)`, backticks, `$variables` — are never interpreted
 * by the remote shell.
 *
 * @param {string} dbPath - Absolute path on the Baanbaan Pi.
 * @returns {string}
 */
function buildCommand(dbPath) {
  const escapedPath = dbPath.replace(/"/g, '\\"');
  return `sqlite3 -json -readonly "${escapedPath}"`;
}

/**
 * Parse `sqlite3 -json` stdout into a row array.
 *
 * sqlite3 outputs a JSON array of objects, or an empty string when the
 * result set is empty.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
function parseRows(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

/** Lists user tables in the database — used to enrich "no such table" errors. */
const SCHEMA_LIST_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/**
 * Best-effort lookup of the available table names, run as a follow-up read
 * after a query fails with "no such table".  Returns [] if the lookup itself
 * fails so the original error is never masked by a secondary failure.
 *
 * @param {string} cmd - The already-built sqlite3 -json -readonly command.
 * @param {number} timeoutMs
 * @returns {Promise<string[]>}
 */
async function listAvailableTables(cmd, timeoutMs) {
  try {
    const { stdout, exitCode } = await sshBackend.exec(cmd, SCHEMA_LIST_SQL, timeoutMs);
    if (exitCode !== 0) return [];
    return parseRows(stdout).map(r => r.name).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Execute a read-only SQL SELECT query against the Baanbaan SQLite database.
 *
 * @param {{ query: string, limit?: number }} input
 * @returns {Promise<{
 *   rows:          object[],
 *   row_count:     number,
 *   truncated:     boolean,
 *   query_time_ms: number
 * }>}
 * @throws {Error} if the query fails validation, times out, or sqlite3 exits non-zero.
 */
async function handler({ query, limit = DEFAULT_LIMIT }) {
  const { appliance }    = getConfig();
  const dbPath           = appliance.database.path;
  const effectiveLimit   = Math.min(limit, MAX_LIMIT);
  const timeoutMs        = appliance.tools?.db_query?.query_timeout_ms ?? 15000;

  // ── AC2 + AC3: Validate ───────────────────────────────────────────────────
  validateQuery(query);

  // ── AC4: Enforce row limit ────────────────────────────────────────────────
  const finalQuery = applyLimit(query, effectiveLimit);

  // ── AC5: Build command ────────────────────────────────────────────────────
  // The SQL is passed via stdin to avoid shell metacharacter injection.
  const cmd = buildCommand(dbPath);

  // ── AC9: Enforce query-level timeout ──────────────────────────────────────
  // Previously this used Promise.race against a local setTimeout — if the
  // timeout won, the SSH exec stream was left running on the appliance and
  // `sqlite3` continued to completion, accumulating orphan processes per
  // timed-out query (2026-05-18 review §B P1 #7). Delegate to ssh-backend
  // instead: it calls `stream.destroy()` when its timer fires, which closes
  // the channel and terminates the remote process.
  const startTime = Date.now();
  let stdout, stderr, exitCode;
  try {
    ({ stdout, stderr, exitCode } = await sshBackend.exec(cmd, finalQuery, timeoutMs));
  } catch (err) {
    // Surface a stable message for the AC9 timeout path so callers / tests can
    // distinguish a query timeout from other SSH errors. The `.kind` tag set
    // by ssh-backend's classifier is also preserved for programmatic checks.
    if (err && err.kind === 'timeout') {
      const tErr = new Error(`Query timed out after ${timeoutMs}ms`);
      tErr.kind  = 'timeout';
      throw tErr;
    }
    throw err;
  }
  const queryTimeMs = Date.now() - startTime;

  if (exitCode !== 0) {
    const base = `sqlite3 exited with code ${exitCode}: ${stderr.trim()}`;
    // Self-correction aid: when the query references a table that doesn't exist,
    // append the real table list so the caller can retry with a valid name
    // instead of blindly guessing (e.g. station_info → system_metadata).
    if (/no such table/i.test(stderr)) {
      const tables = await listAvailableTables(cmd, timeoutMs);
      if (tables.length > 0) {
        throw new Error(`${base}. Available tables (${tables.length}): ${tables.join(', ')}`);
      }
    }
    throw new Error(base);
  }

  // ── AC6 + AC7: Build result ───────────────────────────────────────────────
  const rows      = parseRows(stdout);
  const rowCount  = rows.length;
  const truncated = rowCount === effectiveLimit;

  return {
    rows,
    row_count:     rowCount,
    truncated,
    query_time_ms: queryTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
