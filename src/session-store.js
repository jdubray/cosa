'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getConfig } = require('../config/cosa.config');

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * DDL statements executed in order during migration.
 * Each entry is idempotent (uses IF NOT EXISTS / CREATE VIRTUAL TABLE IF NOT EXISTS).
 * @type {string[]}
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL UNIQUE,
    parent_id      TEXT,
    trigger_type   TEXT NOT NULL,
    trigger_source TEXT,
    status         TEXT NOT NULL DEFAULT 'open',
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    summary        TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_trigger_type ON sessions(trigger_type)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at  ON sessions(started_at)`,

  `CREATE TABLE IF NOT EXISTS turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id),
    turn_index  INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    created_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    content,
    session_id UNINDEXED,
    turn_index UNINDEXED,
    created_at UNINDEXED,
    content=turns,
    content_rowid=id
  )`,

  // FTS5 sync triggers — keep turns_fts up-to-date automatically.
  `CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns BEGIN
     INSERT INTO turns_fts(rowid, content, session_id, turn_index, created_at)
     VALUES (new.id, new.content, new.session_id, new.turn_index, new.created_at);
   END`,

  `CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON turns BEGIN
     INSERT INTO turns_fts(turns_fts, rowid, content, session_id, turn_index, created_at)
     VALUES ('delete', old.id, old.content, old.session_id, old.turn_index, old.created_at);
   END`,

  `CREATE TRIGGER IF NOT EXISTS turns_fts_update AFTER UPDATE ON turns BEGIN
     INSERT INTO turns_fts(turns_fts, rowid, content, session_id, turn_index, created_at)
     VALUES ('delete', old.id, old.content, old.session_id, old.turn_index, old.created_at);
     INSERT INTO turns_fts(rowid, content, session_id, turn_index, created_at)
     VALUES (new.id, new.content, new.session_id, new.turn_index, new.created_at);
   END`,

  `CREATE TABLE IF NOT EXISTS tool_calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(session_id),
    tool_name     TEXT NOT NULL,
    input         TEXT NOT NULL,
    output        TEXT,
    status        TEXT NOT NULL,
    risk_level    TEXT,
    approval_id   TEXT,
    duration_ms   INTEGER,
    created_at    TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name  ON tool_calls(tool_name)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_status     ON tool_calls(status)`,

  `CREATE TABLE IF NOT EXISTS approvals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id     TEXT NOT NULL UNIQUE,
    session_id      TEXT NOT NULL REFERENCES sessions(session_id),
    tool_call_id    INTEGER REFERENCES tool_calls(id),
    token           TEXT NOT NULL UNIQUE,
    tool_name       TEXT NOT NULL,
    action_summary  TEXT NOT NULL,
    risk_level      TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'once',
    status          TEXT NOT NULL DEFAULT 'pending',
    requested_at    TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    resolved_at     TEXT,
    resolved_by     TEXT,
    operator_note   TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_approvals_token      ON approvals(token)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals(status)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at)`,

  `CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT REFERENCES sessions(session_id),
    severity     TEXT NOT NULL,
    category     TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    sent_at      TEXT,
    email_to     TEXT,
    email_msg_id TEXT
  )`,
];

/**
 * Open (or reuse) the session.db connection and return it.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (_db !== null) return _db;

  const { env } = getConfig();
  const dbDir = path.resolve(process.cwd(), env.dataDir);
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'session.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/**
 * Run all schema migrations against session.db.
 * Safe to call on every startup — all statements are idempotent.
 *
 * @throws {Error} if any migration statement fails.
 */
function runMigrations() {
  const db = getDb();
  const migrate = db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  });
  migrate();
}

/**
 * Close the database connection.
 * **For use in tests and graceful shutdown only.**
 */
function closeDb() {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {string} current time as ISO 8601 string */
function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// CRUD — Sessions
// ---------------------------------------------------------------------------

/**
 * Insert a new session row with status 'open'.
 *
 * @param {string} sessionId - UUID v4 identifying the session.
 * @param {{ type: 'email'|'cron'|'cli', source?: string }} trigger
 *   `type` is the trigger kind; `source` is the sender email, cron task name,
 *   or 'cli'.
 */
function createSession(sessionId, trigger) {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, trigger_type, trigger_source, status, started_at)
       VALUES (?, ?, ?, 'open', ?)`
    )
    .run(sessionId, trigger.type, trigger.source ?? null, now());
}

/**
 * Mark a session as complete and record its outcome summary.
 *
 * @param {string} sessionId
 * @param {string} summary - Brief human-readable outcome.
 */
function closeSession(sessionId, summary) {
  getDb()
    .prepare(
      `UPDATE sessions
       SET status = 'complete', completed_at = ?, summary = ?
       WHERE session_id = ?`
    )
    .run(now(), summary, sessionId);
}

// ---------------------------------------------------------------------------
// CRUD — Turns
// ---------------------------------------------------------------------------

/**
 * Append a message turn to a session.
 * `turn_index` is derived automatically as max(existing) + 1 for the session.
 *
 * @param {string} sessionId
 * @param {'user'|'assistant'|'tool'} role
 * @param {string} content - Message text or JSON tool result.
 * @param {number|null} tokensIn
 * @param {number|null} tokensOut
 */
function saveTurn(sessionId, role, content, tokensIn, tokensOut) {
  const db = getDb();
  const row = db
    .prepare(`SELECT MAX(turn_index) AS max_idx FROM turns WHERE session_id = ?`)
    .get(sessionId);
  const turnIndex = row.max_idx == null ? 0 : row.max_idx + 1;

  db.prepare(
    `INSERT INTO turns (session_id, turn_index, role, content, tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, turnIndex, role, content, tokensIn ?? null, tokensOut ?? null, now());
}

// ---------------------------------------------------------------------------
// FTS5 Search — Turns
// ---------------------------------------------------------------------------

/**
 * Full-text search across all session turns.
 *
 * Uses the FTS5 `bm25` ranking function (lower = better match) so results are
 * ordered with the most relevant turn first.  Joins back to `turns` to include
 * `role`, which is not stored in the FTS index.
 *
 * @param {string} query - FTS5 MATCH expression (e.g. `"disk full"` or `disk AND full`).
 * @param {number} [limit=20] - Maximum number of results to return.
 * @returns {Array<{
 *   session_id: string,
 *   turn_index:  number,
 *   role:        string,
 *   content:     string,
 *   created_at:  string
 * }>}
 */
function searchTurns(query, limit = 20) {
  return getDb()
    .prepare(
      `SELECT t.session_id,
              t.turn_index,
              t.role,
              t.content,
              t.created_at
       FROM   turns_fts
       JOIN   turns t ON t.id = turns_fts.rowid
       WHERE  turns_fts MATCH ?
       ORDER  BY bm25(turns_fts)
       LIMIT  ?`
    )
    .all(query, limit);
}

/**
 * Full-text search across session turns, joined to their parent session for
 * metadata.  Optionally filters by role ('user', 'assistant', 'tool').
 *
 * Results are ranked by BM25 relevance (best match first).
 *
 * @param {string}      query - FTS5 query string.
 * @param {number}      [limit=20] - Maximum rows to return.
 * @param {string|null} [role=null] - Optional role filter.
 * @returns {Array<{
 *   session_id:   string,
 *   started_at:   string,
 *   trigger_type: string,
 *   turn_index:   number,
 *   role:         string,
 *   content:      string,
 *   created_at:   string,
 * }>}
 */
function searchTurnsWithSession(query, limit = 20, role = null) {
  const BASE_SQL =
    `SELECT t.session_id,
            s.started_at,
            s.trigger_type,
            t.turn_index,
            t.role,
            t.content,
            t.created_at
     FROM   turns_fts
     JOIN   turns    t ON t.id = turns_fts.rowid
     JOIN   sessions s ON s.session_id = t.session_id
     WHERE  turns_fts MATCH ?`;

  if (role) {
    return getDb()
      .prepare(`${BASE_SQL} AND t.role = ? ORDER BY bm25(turns_fts) LIMIT ?`)
      .all(query, role, limit);
  }
  return getDb()
    .prepare(`${BASE_SQL} ORDER BY bm25(turns_fts) LIMIT ?`)
    .all(query, limit);
}

// ---------------------------------------------------------------------------
// CRUD — Tool Calls
// ---------------------------------------------------------------------------

/**
 * Record an executed (or pending/denied) tool call.
 *
 * @param {string} sessionId
 * @param {{ tool_name: string, input: object, risk_level?: string,
 *           approval_id?: string, duration_ms?: number }} toolCall
 * @param {object|null} result - Structured output; null when not yet available.
 * @param {'executed'|'pending_approval'|'denied'|'expired'} status
 * @returns {number} The inserted row id.
 */
function saveToolCall(sessionId, toolCall, result, status) {
  const info = getDb()
    .prepare(
      `INSERT INTO tool_calls
         (session_id, tool_name, input, output, status, risk_level, approval_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      toolCall.tool_name,
      JSON.stringify(toolCall.input),
      result != null ? JSON.stringify(result) : null,
      status,
      toolCall.risk_level    ?? null,
      toolCall.approval_id   ?? null,
      toolCall.duration_ms   ?? null,
      now()
    );
  return info.lastInsertRowid;
}

/**
 * Record a tool call that was blocked by the security gate before execution.
 *
 * @param {string} sessionId
 * @param {{ tool_name: string, input: object, risk_level?: string }} toolCall
 * @param {string} reason - Human-readable explanation for the block.
 * @returns {number} The inserted row id.
 */
function recordBlockedToolCall(sessionId, toolCall, reason) {
  const info = getDb()
    .prepare(
      `INSERT INTO tool_calls
         (session_id, tool_name, input, output, status, risk_level, created_at)
       VALUES (?, ?, ?, ?, 'blocked', ?, ?)`
    )
    .run(
      sessionId,
      toolCall.tool_name,
      JSON.stringify(toolCall.input),
      reason,
      toolCall.risk_level ?? null,
      now()
    );
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// CRUD — Approvals
// ---------------------------------------------------------------------------

/**
 * Insert a new approval request with status 'pending'.
 *
 * @param {{ approval_id: string, session_id: string, tool_call_id?: number,
 *           token: string, tool_name: string, action_summary: string,
 *           risk_level: string, scope?: string, expires_at: string }} approvalData
 */
function createApproval(approvalData) {
  getDb()
    .prepare(
      `INSERT INTO approvals
         (approval_id, session_id, tool_call_id, token, tool_name, action_summary,
          risk_level, scope, status, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      approvalData.approval_id,
      approvalData.session_id,
      approvalData.tool_call_id ?? null,
      approvalData.token,
      approvalData.tool_name,
      approvalData.action_summary,
      approvalData.risk_level,
      approvalData.scope ?? 'once',
      now(),
      approvalData.expires_at
    );
}

/**
 * Look up an approval request by its one-time token.
 *
 * @param {string} token
 * @returns {object|undefined} The matching row, or undefined if not found.
 */
function findApprovalByToken(token) {
  return getDb()
    .prepare(`SELECT * FROM approvals WHERE token = ?`)
    .get(token);
}

/**
 * Resolve an approval request (approve, deny, or expire).
 *
 * @param {string} approvalId
 * @param {'approved'|'denied'|'expired'} status
 * @param {string} resolvedBy - Operator email or 'system' for timeout expiry.
 * @param {string|null} note - Optional operator note from the reply email.
 */
function updateApprovalStatus(approvalId, status, resolvedBy, note) {
  getDb()
    .prepare(
      `UPDATE approvals
       SET status = ?, resolved_at = ?, resolved_by = ?, operator_note = ?
       WHERE approval_id = ?`
    )
    .run(status, now(), resolvedBy, note ?? null, approvalId);
}

/**
 * Return all pending approvals whose expiry timestamp has passed.
 *
 * @returns {object[]} Rows from the approvals table with status='pending' and
 *   expires_at <= the current time.
 */
function findExpiredApprovals() {
  return getDb()
    .prepare(
      `SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?`
    )
    .all(now());
}

// ---------------------------------------------------------------------------
// CRUD — Alerts
// ---------------------------------------------------------------------------

/**
 * Insert an alert record into the alerts table.
 *
 * @param {{
 *   session_id?:    string|null,
 *   severity:       string,
 *   category:       string,
 *   title:          string,
 *   body:           string,
 *   sent_at?:       string|null,
 *   email_to?:      string|null,
 *   email_msg_id?:  string|null
 * }} alertData
 * @returns {number} The inserted row id.
 */
function createAlert(alertData) {
  const info = getDb()
    .prepare(
      `INSERT INTO alerts
         (session_id, severity, category, title, body, sent_at, email_to, email_msg_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      alertData.session_id   ?? null,
      alertData.severity,
      alertData.category,
      alertData.title,
      alertData.body,
      alertData.sent_at      ?? null,
      alertData.email_to     ?? null,
      alertData.email_msg_id ?? null
    );
  return info.lastInsertRowid;
}

/**
 * Return the parsed output of the most recent executed tool call for a given
 * tool name within a session.  Used by cron-scheduler to read the
 * health_check result from the DB after the orchestrator session closes.
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @returns {object|null} Parsed JSON output, or null if not found / not parseable.
 */
function getLastToolOutput(sessionId, toolName) {
  const row = getDb()
    .prepare(
      `SELECT output FROM tool_calls
       WHERE session_id = ? AND tool_name = ? AND status = 'executed'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId, toolName);
  if (!row || row.output == null) return null;
  try {
    return JSON.parse(row.output);
  } catch {
    return null;
  }
}

/**
 * Return the most recent alert for a given category and severity that was
 * sent at or after `sinceIso`.  Used for alert deduplication.
 *
 * @param {string} category
 * @param {string} severity
 * @param {string} sinceIso - ISO 8601 lower-bound timestamp (inclusive).
 * @returns {object|undefined} The matching row, or undefined if none found.
 */
function findRecentAlert(category, severity, sinceIso) {
  return getDb()
    .prepare(
      `SELECT * FROM alerts
       WHERE category = ? AND severity = ? AND sent_at >= ?
       ORDER BY sent_at DESC LIMIT 1`
    )
    .get(category, severity, sinceIso);
}

/**
 * Set a session's `parent_id` to its own `session_id` as a self-referential
 * marker that context compression has occurred for this session.
 *
 * @param {string} sessionId
 */
function markSessionCompressed(sessionId) {
  getDb()
    .prepare(`UPDATE sessions SET parent_id = ? WHERE session_id = ?`)
    .run(sessionId, sessionId);
}

/**
 * Return all executed tool calls for a session with their parsed outputs.
 * Results are ordered by execution time (ascending).
 *
 * @param {string} sessionId
 * @returns {Array<{
 *   tool_name:  string,
 *   input:      object|null,
 *   output:     object|null,
 *   created_at: string,
 * }>}
 */
function getSessionToolCalls(sessionId) {
  const rows = getDb()
    .prepare(
      `SELECT tool_name, input, output, created_at
       FROM   tool_calls
       WHERE  session_id = ? AND status = 'executed'
       ORDER  BY created_at ASC`
    )
    .all(sessionId);

  return rows.map(row => ({
    tool_name:  row.tool_name,
    input:      safeParse(row.input),
    output:     safeParse(row.output),
    created_at: row.created_at,
  }));
}

/** @param {string|null} s @returns {object|null} */
function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  getDb,
  runMigrations,
  closeDb,
  // Sessions
  createSession,
  closeSession,
  markSessionCompressed,
  // Turns
  saveTurn,
  searchTurns,
  searchTurnsWithSession,
  // Tool calls
  saveToolCall,
  recordBlockedToolCall,
  // Approvals
  createApproval,
  findApprovalByToken,
  updateApprovalStatus,
  findExpiredApprovals,
  // Tool-call lookup
  getLastToolOutput,
  getSessionToolCalls,
  // Alerts
  createAlert,
  findRecentAlert,
};
