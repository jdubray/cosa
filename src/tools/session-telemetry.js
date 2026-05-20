'use strict';

const { getDb }        = require('../session-store');
const { createLogger } = require('../logger');

const log = createLogger('session-telemetry');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'session_telemetry';
const RISK_LEVEL = 'read';

const DEFAULT_DAYS  = 7;
const DEFAULT_TOP_N = 10;

const SCHEMA = {
  description:
    'Aggregate read-only telemetry over COSA\'s own session.db for the past N days: ' +
    'session volume by agent role and trigger type, tool-usage frequency, approval ' +
    'outcomes/rate, and the top tool errors. Use this to produce the weekly operational ' +
    'report. This queries COSA\'s session history, NOT the appliance database.',
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type:        'integer',
        minimum:     1,
        maximum:     90,
        description: `Look-back window in days (default ${DEFAULT_DAYS}).`,
      },
      top_n: {
        type:        'integer',
        minimum:     1,
        maximum:     50,
        description: `Max rows returned for tool-usage and error breakdowns (default ${DEFAULT_TOP_N}).`,
      },
    },
    required:             [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Compute aggregate session telemetry over a recent time window.
 *
 * All queries are read-only `SELECT`s with bound parameters — no SQL is built
 * from the LLM-supplied input (only the validated integer window/limit are
 * bound), so there is no injection surface.
 *
 * @param {{ days?: number, top_n?: number }} [input={}]
 * @returns {Promise<object>} structured telemetry
 */
async function handler(input = {}) {
  const days  = input.days  ?? DEFAULT_DAYS;
  const topN  = input.top_n ?? DEFAULT_TOP_N;
  const db    = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // ── Sessions by role / trigger type ──────────────────────────────────────
  const sessionsByRole = db.prepare(
    `SELECT COALESCE(agent_role, '(unset)') AS role, COUNT(*) AS count
       FROM sessions WHERE started_at >= ?
      GROUP BY role ORDER BY count DESC`
  ).all(since);

  const sessionsByTriggerType = db.prepare(
    `SELECT trigger_type AS trigger_type, COUNT(*) AS count
       FROM sessions WHERE started_at >= ?
      GROUP BY trigger_type ORDER BY count DESC`
  ).all(since);

  const sessionTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`
  ).get(since).n;

  // ── Tool usage (successful executions) ───────────────────────────────────
  const toolUsage = db.prepare(
    `SELECT tool_name, COUNT(*) AS count
       FROM tool_calls WHERE created_at >= ? AND status = 'executed'
      GROUP BY tool_name ORDER BY count DESC LIMIT ?`
  ).all(since, topN);

  // ── Approval outcomes ────────────────────────────────────────────────────
  const approvalRows = db.prepare(
    `SELECT status, COUNT(*) AS count
       FROM approvals WHERE requested_at >= ?
      GROUP BY status`
  ).all(since);

  const approvals = { approved: 0, denied: 0, expired: 0, pending: 0 };
  for (const row of approvalRows) {
    if (row.status in approvals) approvals[row.status] = row.count;
  }
  const decided      = approvals.approved + approvals.denied + approvals.expired;
  const approvalRate = decided > 0 ? approvals.approved / decided : null;

  // ── Errors: blocked/denied tool calls + dispatch errors (output carries
  //    an {"error": ...} payload even when status stayed 'executed') ─────────
  const errorPredicate =
    `(status IN ('blocked', 'denied') OR output LIKE '%"error"%')`;

  const topErrors = db.prepare(
    `SELECT tool_name, COUNT(*) AS count, MAX(created_at) AS most_recent
       FROM tool_calls WHERE created_at >= ? AND ${errorPredicate}
      GROUP BY tool_name ORDER BY count DESC LIMIT ?`
  ).all(since, topN);

  const recentErrors = db.prepare(
    `SELECT tool_name, status, created_at, substr(output, 1, 200) AS output_sample
       FROM tool_calls WHERE created_at >= ? AND ${errorPredicate}
      ORDER BY created_at DESC LIMIT ?`
  ).all(since, Math.min(topN, 20));

  log.info(`[telemetry] window=${days}d sessions=${sessionTotal} tools=${toolUsage.length} errors=${topErrors.length}`);

  return {
    window_days:              days,
    since,
    session_total:            sessionTotal,
    sessions_by_role:         sessionsByRole,
    sessions_by_trigger_type: sessionsByTriggerType,
    tool_usage:               toolUsage,
    approvals: {
      ...approvals,
      total:         decided + approvals.pending,
      approval_rate: approvalRate,
    },
    top_errors:    topErrors,
    recent_errors: recentErrors,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
