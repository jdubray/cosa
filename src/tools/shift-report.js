'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'shift_report';
const RISK_LEVEL = 'read';

const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS     = 48;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    lookback_hours: {
      type:        'integer',
      default:     DEFAULT_LOOKBACK_HOURS,
      maximum:     MAX_LOOKBACK_HOURS,
      minimum:     1,
      description:
        `Number of hours to look back from now (default ${DEFAULT_LOOKBACK_HOURS}, max ${MAX_LOOKBACK_HOURS}). ` +
        'Ignored when date is provided.',
    },
    date: {
      type:        'string',
      pattern:     '^\\d{4}-\\d{2}-\\d{2}$',
      description:
        'ISO date (YYYY-MM-DD) for a full calendar-day report in UTC. ' +
        'When provided, overrides lookback_hours.',
    },
  },
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Aggregate restaurant POS data for the previous shift period into a structured summary. ' +
    'Accepts a lookback window in hours (default 24, max 48) or an explicit UTC date override (YYYY-MM-DD). ' +
    'Returns order counts by status, payment revenue totals, payment error count, staff on shift, and anomalies. ' +
    'Returns zero counts (does not throw) when no activity exists for the period.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build ISO timestamps for the query window.
 *
 * When `date` is provided the window is the full UTC calendar day.
 * Otherwise the window ends at `now` and starts `lookback_hours` earlier.
 *
 * @param {number} lookbackHours
 * @param {string|undefined} date
 * @returns {{ periodStart: string, periodEnd: string }}
 */
function buildWindow(lookbackHours, date) {
  if (date) {
    return {
      periodStart: `${date}T00:00:00.000Z`,
      periodEnd:   `${date}T23:59:59.999Z`,
    };
  }
  const now = new Date();
  return {
    periodStart: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString(),
    periodEnd:   now.toISOString(),
  };
}

/**
 * Build the sqlite3 shell command.
 * Query SQL is passed via stdin to avoid shell injection.
 *
 * @param {string} dbPath
 * @returns {string}
 */
function buildCommand(dbPath) {
  const escaped = dbPath.replace(/"/g, '\\"');
  return `sqlite3 -json -readonly "${escaped}"`;
}

/**
 * Build the orders summary query.
 *
 * SECURITY NOTE: `periodStart` and `periodEnd` are embedded via string
 * interpolation because the SQL is piped to `sqlite3` via stdin.  Both
 * values are either produced by `new Date()` (server-side) or validated
 * against the strict YYYY-MM-DD pattern in `INPUT_SCHEMA`.
 *
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {string}
 */
function buildOrdersQuery(periodStart, periodEnd) {
  return [
    `SELECT`,
    `  COUNT(*)                                                              AS total_orders,`,
    `  COUNT(CASE WHEN status = 'completed'                       THEN 1 END) AS completed,`,
    `  COUNT(CASE WHEN status = 'cancelled'                       THEN 1 END) AS cancelled,`,
    `  COUNT(CASE WHEN status IN ('confirmed','preparing','ready') THEN 1 END) AS active`,
    `FROM orders`,
    `WHERE created_at >= '${periodStart}'`,
    `  AND created_at <= '${periodEnd}'`,
  ].join(' ');
}

/**
 * Build the payments revenue query.
 *
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {string}
 */
function buildRevenueQuery(periodStart, periodEnd) {
  return [
    `SELECT`,
    `  COUNT(*)                  AS payment_count,`,
    `  round(SUM(amount), 2)     AS total_revenue,`,
    `  round(AVG(amount), 2)     AS avg_order_value`,
    `FROM payments`,
    `WHERE created_at >= '${periodStart}'`,
    `  AND created_at <= '${periodEnd}'`,
  ].join(' ');
}

/**
 * Build the payment errors count query.
 *
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {string}
 */
function buildPaymentErrorsQuery(periodStart, periodEnd) {
  return [
    `SELECT COUNT(*) AS error_count`,
    `FROM payment_errors`,
    `WHERE created_at >= '${periodStart}'`,
    `  AND created_at <= '${periodEnd}'`,
  ].join(' ');
}

/**
 * Build the staff-on-shift query.
 * Counts distinct employees whose timesheet clock-in falls within the window,
 * including any who are still clocked in (clock_out IS NULL).
 *
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {string}
 */
function buildStaffQuery(periodStart, periodEnd) {
  return [
    `SELECT COUNT(DISTINCT employee_id) AS staff_count`,
    `FROM timesheets`,
    `WHERE clock_in >= '${periodStart}'`,
    `  AND (clock_out IS NULL OR clock_out <= '${periodEnd}')`,
  ].join(' ');
}

/**
 * Run a SQL statement against the appliance database via SSH.
 *
 * @param {string} cmd  - sqlite3 shell command (built by buildCommand).
 * @param {string} sql  - SQL to pass via stdin.
 * @returns {Promise<object[]>}
 */
async function execQuery(cmd, sql) {
  const { stdout, stderr, exitCode } = await sshBackend.exec(cmd, sql);
  if (exitCode !== 0) {
    throw new Error(`sqlite3 exited with code ${exitCode}: ${stderr.trim()}`);
  }
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/**
 * Identify anomalies from the aggregated shift metrics.
 *
 * Current rules:
 * - More than 5 payment errors in the period.
 * - Orders placed but zero payments recorded.
 * - Cancellation rate exceeds 30 % (with at least 5 orders to avoid noise).
 *
 * @param {{ totalOrders: number, cancelledOrders: number, paymentErrors: number, paymentCount: number }} metrics
 * @returns {string[]}
 */
function detectAnomalies({ totalOrders, cancelledOrders, paymentErrors, paymentCount }) {
  const anomalies = [];

  if (paymentErrors > 5) {
    anomalies.push(`High payment error count: ${paymentErrors} errors in period`);
  }

  if (totalOrders > 0 && paymentCount === 0) {
    anomalies.push(`Orders placed but no payments recorded — possible payment system issue`);
  }

  if (totalOrders >= 5 && cancelledOrders / totalOrders > 0.3) {
    anomalies.push(
      `High cancellation rate: ${cancelledOrders} of ${totalOrders} orders cancelled ` +
      `(${Math.round((cancelledOrders / totalOrders) * 100)} %)`
    );
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Aggregate restaurant POS data into a structured shift report.
 *
 * @param {{ lookback_hours?: number, date?: string }} input
 * @returns {Promise<{
 *   period_start:    string,
 *   period_end:      string,
 *   orders:          { total: number, completed: number, cancelled: number, active: number },
 *   revenue:         { payment_count: number, total: number, avg_order_value: number, currency: string },
 *   payment_errors:  number,
 *   staff_count:     number,
 *   anomalies:       string[],
 *   generated_at:    string,
 * }>}
 */
async function handler({ lookback_hours = DEFAULT_LOOKBACK_HOURS, date } = {}) {
  const { appliance }     = getConfig();
  const dbPath            = appliance.database.path;
  const effectiveLookback = Math.min(lookback_hours, MAX_LOOKBACK_HOURS);

  const { periodStart, periodEnd } = buildWindow(effectiveLookback, date);
  const cmd = buildCommand(dbPath);

  // ── Run all four queries in parallel ──────────────────────────────────────
  const [orderRows, revenueRows, errorRows, staffRows] = await Promise.all([
    execQuery(cmd, buildOrdersQuery(periodStart, periodEnd)),
    execQuery(cmd, buildRevenueQuery(periodStart, periodEnd)),
    execQuery(cmd, buildPaymentErrorsQuery(periodStart, periodEnd)),
    execQuery(cmd, buildStaffQuery(periodStart, periodEnd)),
  ]);

  const orders  = orderRows[0]   ?? {};
  const revenue = revenueRows[0] ?? {};
  const errors  = errorRows[0]   ?? {};
  const staff   = staffRows[0]   ?? {};

  const anomalies = detectAnomalies({
    totalOrders:     orders.total_orders   ?? 0,
    cancelledOrders: orders.cancelled      ?? 0,
    paymentErrors:   errors.error_count    ?? 0,
    paymentCount:    revenue.payment_count ?? 0,
  });

  return {
    period_start: periodStart,
    period_end:   periodEnd,
    orders: {
      total:     orders.total_orders ?? 0,
      completed: orders.completed    ?? 0,
      cancelled: orders.cancelled    ?? 0,
      active:    orders.active       ?? 0,
    },
    revenue: {
      payment_count:   revenue.payment_count   ?? 0,
      total:           revenue.total_revenue   ?? 0,
      avg_order_value: revenue.avg_order_value ?? 0,
      currency:        'USD',
    },
    payment_errors: errors.error_count ?? 0,
    staff_count:    staff.staff_count  ?? 0,
    anomalies,
    generated_at:   new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
