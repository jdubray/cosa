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
  required: [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Aggregate WeatherStation readings for the previous shift period into a ' +
    'structured summary.  Accepts a lookback window in hours (default 24, max 48) ' +
    'or an explicit UTC date override (YYYY-MM-DD).  Returns temperature, humidity, ' +
    'condition breakdown, and anomaly list.  Errors if no readings exist for the period.',
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
    const periodStart = `${date}T00:00:00.000Z`;
    const periodEnd   = `${date}T23:59:59.999Z`;
    return { periodStart, periodEnd };
  }

  const now           = new Date();
  const periodEnd     = now.toISOString();
  const periodStart   = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
  return { periodStart, periodEnd };
}

/**
 * Build the sqlite3 aggregation command.
 * Query is passed via stdin to `sshBackend.exec` to avoid shell injection.
 *
 * @param {string} dbPath
 * @returns {string}
 */
function buildCommand(dbPath) {
  const escaped = dbPath.replace(/"/g, '\\"');
  return `sqlite3 -json -readonly "${escaped}"`;
}

/**
 * Build the aggregation SQL for the readings table.
 *
 * Returns a single JSON row with aggregate metrics plus a JSON array of
 * condition breakdowns.
 *
 * SECURITY NOTE: `periodStart` and `periodEnd` are embedded via string
 * interpolation because the SQL is piped to `sqlite3` via stdin and
 * parameterised queries are unavailable in that execution model.
 * Both values are either produced by `new Date()` (server-side, no user
 * input) or derived from a date string that has already been validated
 * against the strict YYYY-MM-DD pattern in `INPUT_SCHEMA`.  Do NOT loosen
 * that schema validation without reviewing these queries first.
 *
 * @param {string} periodStart - ISO timestamp
 * @param {string} periodEnd   - ISO timestamp
 * @returns {string}
 */
function buildAggregationQuery(periodStart, periodEnd) {
  // SQLite doesn't support ROUND(x,2) natively but does accept round(x,2).
  return [
    `SELECT`,
    `  COUNT(*)                            AS total_readings,`,
    `  round(MIN(temperature_c), 2)        AS temp_min,`,
    `  round(MAX(temperature_c), 2)        AS temp_max,`,
    `  round(AVG(temperature_c), 2)        AS temp_avg,`,
    `  round(AVG(humidity_pct), 2)         AS humidity_avg,`,
    `  round(MIN(humidity_pct), 2)         AS humidity_min,`,
    `  round(MAX(humidity_pct), 2)         AS humidity_max`,
    `FROM readings`,
    `WHERE recorded_at >= '${periodStart}'`,
    `  AND recorded_at <= '${periodEnd}'`,
  ].join(' ');
}

/**
 * Build the condition breakdown query for the same window.
 *
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {string}
 */
function buildConditionsQuery(periodStart, periodEnd) {
  return [
    `SELECT`,
    `  weather_description AS condition,`,
    `  COUNT(*)            AS count`,
    `FROM readings`,
    `WHERE recorded_at >= '${periodStart}'`,
    `  AND recorded_at <= '${periodEnd}'`,
    `GROUP BY weather_description`,
    `ORDER BY count DESC`,
  ].join(' ');
}

/**
 * Run a SQL statement against the appliance database via SSH.
 *
 * @param {string} cmd   - The sqlite3 shell command (built by buildCommand).
 * @param {string} sql   - SQL to pass via stdin.
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
 * Identify anomalies from aggregate metrics.
 *
 * Current rules:
 * - Temperature exceeds 40 °C or drops below -10 °C.
 * - Humidity exceeds 95 %.
 *
 * @param {{ temp_min: number, temp_max: number, humidity_max: number }} metrics
 * @returns {string[]}
 */
function detectAnomalies({ temp_min, temp_max, humidity_max }) {
  const anomalies = [];
  if (temp_max !== null && temp_max > 40) {
    anomalies.push(`High temperature: ${temp_max} °C (threshold: 40 °C)`);
  }
  if (temp_min !== null && temp_min < -10) {
    anomalies.push(`Low temperature: ${temp_min} °C (threshold: -10 °C)`);
  }
  if (humidity_max !== null && humidity_max > 95) {
    anomalies.push(`High humidity: ${humidity_max} % (threshold: 95 %)`);
  }
  return anomalies;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Aggregate WeatherStation readings into a structured shift report.
 *
 * @param {{ lookback_hours?: number, date?: string }} input
 * @returns {Promise<{
 *   period_start:    string,
 *   period_end:      string,
 *   total_readings:  number,
 *   temperature:     { min: number, max: number, avg: number, unit: string },
 *   humidity:        { min: number, max: number, avg: number, unit: string },
 *   conditions:      Array<{ condition: string, count: number }>,
 *   anomalies:       string[],
 *   generated_at:    string,
 * }>}
 * @throws {Error} if no readings exist for the requested period.
 */
async function handler({ lookback_hours = DEFAULT_LOOKBACK_HOURS, date } = {}) {
  const { appliance } = getConfig();
  const dbPath        = appliance.database.path;
  const effectiveLookback = Math.min(lookback_hours, MAX_LOOKBACK_HOURS);

  const { periodStart, periodEnd } = buildWindow(effectiveLookback, date);
  const cmd = buildCommand(dbPath);

  // ── Run both queries in parallel ─────────────────────────────────────────
  const [aggRows, condRows] = await Promise.all([
    execQuery(cmd, buildAggregationQuery(periodStart, periodEnd)),
    execQuery(cmd, buildConditionsQuery(periodStart, periodEnd)),
  ]);

  const agg = aggRows[0] ?? {};

  // ── AC5: Error if no readings for the period ──────────────────────────────
  if (!agg.total_readings || agg.total_readings === 0) {
    throw new Error(
      `No readings found between ${periodStart} and ${periodEnd}. ` +
      'The appliance may not have recorded data for this period.'
    );
  }

  const anomalies = detectAnomalies({
    temp_min:    agg.temp_min,
    temp_max:    agg.temp_max,
    humidity_max: agg.humidity_max,
  });

  return {
    period_start:   periodStart,
    period_end:     periodEnd,
    total_readings: agg.total_readings,
    temperature: {
      min:  agg.temp_min,
      max:  agg.temp_max,
      avg:  agg.temp_avg,
      unit: '°C',
    },
    humidity: {
      min:  agg.humidity_min,
      max:  agg.humidity_max,
      avg:  agg.humidity_avg,
      unit: '%',
    },
    conditions:  condRows,
    anomalies,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
