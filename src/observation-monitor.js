'use strict';

/**
 * Data-driven observation primitive (self-extending monitoring, Phase 1).
 *
 * A "monitor" is expressed as DATA (see config/observation-monitors.js): it
 * picks a read-only PROBE, supplies params + numeric thresholds, and provides a
 * report template. New monitors are new data rows — no new code — which is what
 * lets COSA later author its own (Phase 2, approval-gated). Probes are
 * deliberately limited to signals the watcher system CANNOT see (SSH commands,
 * logs); snapshot fields are already covered by watchers.
 *
 * Safety: every probe is read-only and its inputs are validated/escaped, so a
 * monitor definition can never become arbitrary command execution.
 */

const net              = require('net');
const { execFile }     = require('child_process');
const sshBackend       = require('./ssh-backend');
const { shEscape }     = require('./shell-utils');
const { getConfig }    = require('../config/cosa.config');
const { createLogger } = require('./logger');

const log = createLogger('observation-monitor');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UNIT_RE = /^[A-Za-z0-9_.@-]+\.service$/;

/**
 * Statement keywords a read-only observation query must never contain.
 * `sqlite3 -readonly` already blocks writes at the engine level; this is the
 * belt-and-braces layer, and it also blocks the file-touching extensions
 * (ATTACH / readfile / writefile / load_extension) that read-only mode allows.
 */
const FORBIDDEN_SQL_RE =
  /\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|vacuum|begin|commit|rollback|load_extension|readfile|writefile|edit)\b/i;

function invalid(msg) {
  const err = new Error(msg);
  err.code  = 'OBSERVATION_INVALID';
  return err;
}

/**
 * Validate that a monitor-supplied query is a single bare read-only SELECT.
 * Shared by every SQLite-backed probe so a monitor definition can never become
 * arbitrary command execution, whichever database it targets.
 *
 * @param {unknown} rawSql
 * @param {string}  probeName  used in error messages
 * @returns {string} the trimmed SQL
 */
function validateReadOnlySelect(rawSql, probeName) {
  const sql = String(rawSql ?? '').trim();
  if (!sql) throw invalid(`${probeName} requires a sql param`);
  if (!/^SELECT\s/i.test(sql)) throw invalid(`${probeName} sql must start with SELECT`);
  if (sql.includes(';')) throw invalid(`${probeName} sql must be a single statement (no ";")`);
  if (/--|\/\*/.test(sql)) throw invalid(`${probeName} sql must not contain comments`);
  if (FORBIDDEN_SQL_RE.test(sql)) throw invalid(`${probeName} sql contains a forbidden keyword`);
  return sql;
}

/**
 * Run `sqlite3 -readonly` on the COSA host itself (not the appliance) with the
 * SQL on stdin, tab-separated output. Resolves { stdout, stderr, exitCode }.
 *
 * @param {string} dbPath
 * @param {string} sql
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function execLocalSqlite(dbPath, sql, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      'sqlite3', ['-readonly', '-separator', '\t', dbPath],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), exitCode });
      }
    );
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** Clamp to an integer in [min, max], falling back to def for non-finite input. */
function clampInt(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Throttle decode (mirrors resource-threshold-monitor) — voltage focus
// ---------------------------------------------------------------------------

const THROTTLE_LABELS = {
  0: 'under-voltage detected (now)', 1: 'ARM frequency capped (now)',
  2: 'currently throttled', 3: 'soft temperature limit active (now)',
  16: 'under-voltage has occurred since boot', 17: 'ARM frequency capping has occurred',
  18: 'throttling has occurred', 19: 'soft temperature limit has occurred',
};

// ---------------------------------------------------------------------------
// Probe registry — each probe: async (params) => { value:number, context:object }
// `value` is the number compared against the monitor's thresholds.
// ---------------------------------------------------------------------------

const PROBES = {
  /**
   * Raspberry Pi under-voltage / throttle state via `vcgencmd get_throttled`.
   * value: 2 = under-voltage NOW, 1 = under-voltage occurred since boot, 0 = clean.
   */
  async vcgencmd_throttled() {
    const r   = await sshBackend.exec('vcgencmd get_throttled');
    const m   = /throttled=0x([0-9a-fA-F]+)/.exec(String(r.stdout ?? ''));
    if (!m) throw invalid('vcgencmd returned no parseable throttled flag');
    const bits = parseInt(m[1], 16);
    const active = Object.keys(THROTTLE_LABELS).map(Number).filter(b => (bits & (1 << b)) !== 0);
    const uvNow = (bits & (1 << 0))  !== 0;
    const uvOcc = (bits & (1 << 16)) !== 0;
    const value = uvNow ? 2 : (uvOcc ? 1 : 0);
    return {
      value,
      context: {
        raw: '0x' + bits.toString(16),
        undervoltage_now: uvNow,
        undervoltage_occurred: uvOcc,
        conditions: active.map(b => THROTTLE_LABELS[b]).join('; ') || 'none',
      },
    };
  },

  /**
   * Count journald lines (one systemd unit, recent window) that contain ALL of
   * the given fixed-string patterns. value: the match count.
   * params: { unit, window_minutes, patterns: string[] | pattern: string }
   */
  async log_pattern_count(params) {
    const unit = String(params.unit ?? '');
    if (!UNIT_RE.test(unit)) throw invalid(`Invalid unit "${unit}" — must match ${UNIT_RE}`);
    const mins = clampInt(params.window_minutes, 1, 1440, 60);
    const patterns = Array.isArray(params.patterns)
      ? params.patterns
      : (params.pattern != null ? [params.pattern] : []);
    if (patterns.length === 0) throw invalid('log_pattern_count requires patterns[] or pattern');

    // journalctl ... | grep -F 'p0' | grep -F 'p1' | grep -Fc 'pLast'  (AND of fixed strings)
    let pipe = `journalctl -u '${shEscape(unit)}' --since "${mins} minutes ago" -o cat --no-pager 2>/dev/null`;
    patterns.forEach((p, i) => {
      const flag = i === patterns.length - 1 ? '-Fc' : '-F';
      pipe += ` | grep ${flag} '${shEscape(String(p))}'`;
    });
    pipe += ' || true';

    const r = await sshBackend.exec(pipe);
    const count = parseInt(String(r.stdout ?? '').trim(), 10) || 0;
    return { value: count, context: { unit, window_minutes: mins, patterns, match_count: count } };
  },

  /**
   * LAN reachability of a fixed IPv4 host (e.g. a wired receipt printer) via
   * `ping` from the appliance. value: packet loss percentage (0-100); a host
   * that never replies reports 100.
   * params: { host, count? }
   */
  async ping_reachability(params) {
    const host = String(params.host ?? '');
    if (net.isIP(host) !== 4) throw invalid(`Invalid host "${host}" — must be an IPv4 address`);
    const count = clampInt(params.count, 1, 10, 3);

    const r = await sshBackend.exec(`ping -c ${count} -W 2 '${shEscape(host)}' || true`);
    // iputils prints loss with %g, so partial loss is fractional ("33.3333%").
    // The capture must include the decimal part or the digits after the dot
    // are matched alone ("3333% packet loss" → false high alert, 2026-08-11).
    const m = /(\d+(?:\.\d+)?)% packet loss/.exec(String(r.stdout ?? ''));
    const packetLossPct = m ? Math.round(parseFloat(m[1])) : 100;

    return {
      value: packetLossPct,
      context: { host, count, packet_loss_pct: packetLossPct },
    };
  },

  /**
   * Single numeric value from a read-only SELECT against the appliance's
   * SQLite database. value: the scalar the query returns.
   *
   * This is the probe for "a number that only the POS database knows" —
   * backlog sizes, row counts, staleness. It exists because a silent data
   * stall (e.g. the processor-fee backfill that died 2026-07-08 and produced
   * no error line for two months) is invisible to both the log-pattern probe
   * and the snapshot watchers.
   *
   * Safety: the DB path comes from config, never from the monitor definition;
   * `sqlite3 -readonly` makes writes impossible at the engine level; the SQL
   * is passed on stdin (never interpolated into the command line); and the
   * statement must be a single bare SELECT. A monitor definition therefore
   * still cannot become arbitrary command execution.
   *
   * params: { sql }
   */
  async sqlite_scalar(params) {
    const { appliance } = getConfig();
    const dbPath = appliance.database?.path;
    if (!dbPath) throw invalid('appliance.database.path is not configured');

    const sql = validateReadOnlySelect(params.sql, 'sqlite_scalar');

    const escapedPath = String(dbPath).replace(/"/g, '\\"');
    const r = await sshBackend.exec(`sqlite3 -readonly "${escapedPath}"`, sql, 10000);
    if (r.exitCode !== 0) {
      throw invalid(`sqlite3 exited ${r.exitCode}: ${String(r.stderr ?? '').trim()}`);
    }

    const raw   = String(r.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
    const value = Number(raw);
    if (!Number.isFinite(value)) throw invalid(`Query returned a non-numeric value: "${raw}"`);

    return { value, context: { value, db_path: dbPath } };
  },

  /**
   * Numeric value (plus an optional label) from a read-only SELECT against
   * the Pi-hole FTL query log on the COSA host. value: first column of the
   * first row; label: second column when present (typically the client IP or
   * domain the number belongs to, so the alert can name the offender).
   *
   * This is the probe for "what is the LAN asking the resolver" — per-client
   * query floods, domain spread, NXDOMAIN bursts, blocklist hits — the signals
   * a compromised IoT device (residential-proxy / botnet firmware) produces
   * and that the appliance-side probes cannot see. Runs locally because the
   * resolver lives on the COSA Pi 5, not the PCI-scoped POS appliance.
   *
   * Safety: the DB path comes from config (dns_monitor.pihole_db_path), never
   * from the monitor definition; `sqlite3 -readonly` blocks writes at the
   * engine level; SQL is passed on stdin via execFile (no shell); and the
   * statement must be a single bare SELECT (validateReadOnlySelect).
   *
   * params: { sql }
   */
  async pihole_dns_scalar(params) {
    const { appliance } = getConfig();
    const dbPath = appliance.dns_monitor?.pihole_db_path;
    if (!dbPath) throw invalid('dns_monitor.pihole_db_path is not configured');

    const sql = validateReadOnlySelect(params.sql, 'pihole_dns_scalar');

    const r = await execLocalSqlite(String(dbPath), sql, 10000);
    if (r.exitCode !== 0) {
      throw invalid(`sqlite3 exited ${r.exitCode}: ${r.stderr.trim()}`);
    }

    const firstRow = r.stdout.trim().split(/\r?\n/)[0] ?? '';
    // An aggregate over an empty window yields no row at all — that is a
    // healthy zero, not a probe failure.
    if (firstRow === '') return { value: 0, context: { value: 0, label: '', db_path: dbPath } };

    const [rawValue, rawLabel = ''] = firstRow.split('\t');
    const value = Number(rawValue);
    if (rawValue.trim() === '' || !Number.isFinite(value)) {
      throw invalid(`Query returned a non-numeric first column: "${rawValue}"`);
    }
    const label = rawLabel.trim();

    return { value, context: { value, label, db_path: dbPath } };
  },
};

// ---------------------------------------------------------------------------
// Threshold comparison + template rendering
// ---------------------------------------------------------------------------

/**
 * Compare a numeric value to a monitor's thresholds → severity.
 * threshold: { comparator: 'gte'|'gt'|'lt'|'lte'|'eq', medium?, high? }
 * High is checked first; default comparator is 'gte'.
 *
 * @returns {'none'|'medium'|'high'}
 */
function classify(value, threshold = {}) {
  const cmp = (v, t) => {
    switch (threshold.comparator) {
      case 'gt':  return v >  t;
      case 'lt':  return v <  t;
      case 'lte': return v <= t;
      case 'eq':  return v === t;
      case 'gte':
      default:    return v >= t;
    }
  };
  if (threshold.high   != null && cmp(value, threshold.high))   return 'high';
  if (threshold.medium != null && cmp(value, threshold.medium)) return 'medium';
  return 'none';
}

/** Substitute {{var}} placeholders; unknown placeholders are left intact. */
function renderTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] != null ? String(vars[k]) : `{{${k}}}`
  );
}

// ---------------------------------------------------------------------------
// Evaluate one monitor definition
// ---------------------------------------------------------------------------

/**
 * Run a monitor definition's probe, classify its value, and render the report.
 *
 * @param {{ id: string, probe: string, params?: object, threshold?: object, report_template?: string }} def
 * @returns {Promise<{ id, probe, value, severity, context, report, checked_at }>}
 */
async function evaluateMonitor(def) {
  if (!def || typeof def.id !== 'string') throw invalid('Monitor definition needs a string id');
  const probe = PROBES[def.probe];
  if (!probe) throw invalid(`Unknown probe type: "${def.probe}"`);

  const { value, context } = await probe(def.params ?? {});
  const severity  = classify(value, def.threshold ?? {});
  const checkedAt = new Date().toISOString();
  const vars      = { id: def.id, value, severity, checked_at: checkedAt, ...context };
  const report    = severity === 'none' ? null : renderTemplate(def.report_template, vars);

  log.info(`[observation] ${def.id}: value=${value} severity=${severity}`);
  return { id: def.id, probe: def.probe, value, severity, context, report, checked_at: checkedAt };
}

module.exports = { evaluateMonitor, classify, renderTemplate, PROBES, clampInt, UNIT_RE };
