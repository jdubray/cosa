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
  const startTime = Date.now();

  const execPromise    = sshBackend.exec(cmd, finalQuery);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Query timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  );

  const { stdout, stderr, exitCode } = await Promise.race([execPromise, timeoutPromise]);
  const queryTimeMs = Date.now() - startTime;

  if (exitCode !== 0) {
    throw new Error(`sqlite3 exited with code ${exitCode}: ${stderr.trim()}`);
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
