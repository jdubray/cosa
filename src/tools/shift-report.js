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

// Status buckets — covers every value in orders.status CHECK constraint.
// Update both the SQL and STATUS_BUCKETS together if BaanBaan extends the set.
const STATUS_BUCKETS = {
  paid:      ['paid', 'completed', 'picked_up'],
  cancelled: ['cancelled', 'pos_error'],
  refunded:  ['refunded'],
  active:    ['pending_payment', 'received', 'submitted', 'confirmed', 'preparing', 'ready'],
};

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
    'Returns order counts by status bucket (paid / cancelled / refunded / active), payments and service-charge totals, ' +
    'payment-error count, staff on shift, and anomalies. Returns zero counts (does not throw) when no activity exists.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert ISO 8601 ('2026-04-25T13:00:00.000Z') to SQLite space format
 * ('2026-04-25 13:00:00') so it lex-compares correctly against
 * `datetime('now')`-stored columns.
 *
 * @param {string} iso
 * @returns {string}
 */
function isoToSpace(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * Build the query window.
 *
 * Returns ISO bounds for the response payload (`period_start` / `period_end`)
 * and matching space-format bounds for the SQL filters. The window is
 * half-open: `>= start` and `< end`.
 *
 * @param {number} lookbackHours
 * @param {string|undefined} date
 * @returns {{ periodStart: string, periodEnd: string, queryStart: string, queryEnd: string }}
 */
function buildWindow(lookbackHours, date) {
  let isoStart;
  let isoEnd;

  if (date) {
    isoStart = `${date}T00:00:00.000Z`;
    const next = new Date(isoStart);
    next.setUTCDate(next.getUTCDate() + 1);
    isoEnd = next.toISOString();
  } else {
    const now = new Date();
    isoEnd   = now.toISOString();
    isoStart = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
  }

  return {
    periodStart: isoStart,
    periodEnd:   isoEnd,
    queryStart:  isoToSpace(isoStart),
    queryEnd:    isoToSpace(isoEnd),
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
 * Render a list of statuses as a SQL `IN (...)` literal list.
 * Inputs are hard-coded constants in STATUS_BUCKETS, never user input.
 *
 * @param {string[]} statuses
 * @returns {string}
 */
function inList(statuses) {
  return statuses.map((s) => `'${s}'`).join(', ');
}

/**
 * Build the orders summary query.
 *
 * Buckets every legal status value from the BaanBaan CHECK constraint into one
 * of paid / cancelled / refunded / active. The handler asserts the buckets
 * sum to total_orders so a future status addition surfaces immediately.
 *
 * Also aggregates `service_charge_cents` here because service charge is stored
 * only on `orders` — the `payments` table does not carry it.
 *
 * SECURITY: `queryStart` / `queryEnd` come from `buildWindow`, which produces
 * them either from `new Date()` or from a date string validated against
 * `^\d{4}-\d{2}-\d{2}$`. Both are then sliced into `YYYY-MM-DD HH:MM:SS`
 * shape, so direct interpolation is safe. The SQL is piped to sqlite3 stdin.
 *
 * @param {string} queryStart
 * @param {string} queryEnd
 * @returns {string}
 */
function buildOrdersQuery(queryStart, queryEnd) {
  return [
    `SELECT`,
    `  COUNT(*)                                                       AS total_orders,`,
    `  COUNT(CASE WHEN status IN (${inList(STATUS_BUCKETS.paid)})      THEN 1 END) AS paid,`,
    `  COUNT(CASE WHEN status IN (${inList(STATUS_BUCKETS.cancelled)}) THEN 1 END) AS cancelled,`,
    `  COUNT(CASE WHEN status IN (${inList(STATUS_BUCKETS.refunded)})  THEN 1 END) AS refunded,`,
    `  COUNT(CASE WHEN status IN (${inList(STATUS_BUCKETS.active)})    THEN 1 END) AS active,`,
    `  COALESCE(SUM(service_charge_cents), 0)                         AS service_charge_cents`,
    `FROM orders`,
    `WHERE datetime(created_at) >= datetime('${queryStart}')`,
    `  AND datetime(created_at) <  datetime('${queryEnd}')`,
  ].join(' ');
}

/**
 * Build the payments revenue query.
 *
 * @param {string} queryStart
 * @param {string} queryEnd
 * @returns {string}
 */
function buildRevenueQuery(queryStart, queryEnd) {
  return [
    `SELECT`,
    `  COUNT(*)                              AS payment_count,`,
    `  COALESCE(SUM(amount_cents), 0)       AS amount_cents`,
    `FROM payments`,
    `WHERE datetime(created_at) >= datetime('${queryStart}')`,
    `  AND datetime(created_at) <  datetime('${queryEnd}')`,
  ].join(' ');
}

/**
 * Build the payment errors count query.
 *
 * @param {string} queryStart
 * @param {string} queryEnd
 * @returns {string}
 */
function buildPaymentErrorsQuery(queryStart, queryEnd) {
  return [
    `SELECT COUNT(*) AS error_count`,
    `FROM payment_errors`,
    `WHERE datetime(occurred_at) >= datetime('${queryStart}')`,
    `  AND datetime(occurred_at) <  datetime('${queryEnd}')`,
  ].join(' ');
}

/**
 * Build the staff-on-shift query.
 *
 * Counts distinct employees whose timesheet clock_in falls within the window.
 * Includes employees still clocked in (clock_out IS NULL) at the end of the
 * window — they were on shift during it.
 *
 * @param {string} queryStart
 * @param {string} queryEnd
 * @returns {string}
 */
function buildStaffQuery(queryStart, queryEnd) {
  return [
    `SELECT COUNT(DISTINCT employee_id) AS staff_count`,
    `FROM timesheets`,
    `WHERE datetime(clock_in) >= datetime('${queryStart}')`,
    `  AND datetime(clock_in) <  datetime('${queryEnd}')`,
    `  AND (clock_out IS NULL OR datetime(clock_out) <= datetime('${queryEnd}'))`,
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
 * Round a number to 2 decimal places without floating-point drift surprises.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
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
 *   orders:          { total: number, paid: number, cancelled: number, refunded: number, active: number },
 *   revenue:         {
 *     payment_count:        number,
 *     payments_total:       number,
 *     service_charge_total: number,
 *     total:                number,
 *     avg_order_value:      number,
 *     currency:             string,
 *   },
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

  const { periodStart, periodEnd, queryStart, queryEnd } =
    buildWindow(effectiveLookback, date);
  const cmd = buildCommand(dbPath);

  const [orderRows, revenueRows, errorRows, staffRows] = await Promise.all([
    execQuery(cmd, buildOrdersQuery(queryStart, queryEnd)),
    execQuery(cmd, buildRevenueQuery(queryStart, queryEnd)),
    execQuery(cmd, buildPaymentErrorsQuery(queryStart, queryEnd)),
    execQuery(cmd, buildStaffQuery(queryStart, queryEnd)),
  ]);

  const ordersRow  = orderRows[0]   ?? {};
  const revenueRow = revenueRows[0] ?? {};
  const errorsRow  = errorRows[0]   ?? {};
  const staffRow   = staffRows[0]   ?? {};

  const total      = ordersRow.total_orders ?? 0;
  const paid       = ordersRow.paid         ?? 0;
  const cancelled  = ordersRow.cancelled    ?? 0;
  const refunded   = ordersRow.refunded     ?? 0;
  const active     = ordersRow.active       ?? 0;

  // Surface unknown-status drift if BaanBaan extends the CHECK constraint.
  if (paid + cancelled + refunded + active !== total) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shift-report] status bucket invariant violated: ` +
      `total=${total} paid=${paid} cancelled=${cancelled} refunded=${refunded} active=${active}`
    );
  }

  const paymentCount       = revenueRow.payment_count ?? 0;
  const paymentsTotal      = round2((revenueRow.amount_cents     ?? 0) / 100);
  const serviceChargeTotal = round2((ordersRow.service_charge_cents ?? 0) / 100);
  const grandTotal         = round2(paymentsTotal + serviceChargeTotal);
  const avgOrderValue      = paid > 0 ? round2(grandTotal / paid) : 0;

  const anomalies = detectAnomalies({
    totalOrders:     total,
    cancelledOrders: cancelled,
    paymentErrors:   errorsRow.error_count ?? 0,
    paymentCount,
  });

  return {
    period_start: periodStart,
    period_end:   periodEnd,
    orders: {
      total,
      paid,
      cancelled,
      refunded,
      active,
    },
    revenue: {
      payment_count:        paymentCount,
      payments_total:       paymentsTotal,
      service_charge_total: serviceChargeTotal,
      total:                grandTotal,
      avg_order_value:      avgOrderValue,
      currency:             'USD',
    },
    payment_errors: errorsRow.error_count ?? 0,
    staff_count:    staffRow.staff_count  ?? 0,
    anomalies,
    generated_at:   new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
