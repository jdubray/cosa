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

const sshBackend       = require('./ssh-backend');
const { shEscape }     = require('./shell-utils');
const { createLogger } = require('./logger');

const log = createLogger('observation-monitor');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UNIT_RE = /^[A-Za-z0-9_.@-]+\.service$/;

function invalid(msg) {
  const err = new Error(msg);
  err.code  = 'OBSERVATION_INVALID';
  return err;
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
