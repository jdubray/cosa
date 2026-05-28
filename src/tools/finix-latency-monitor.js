'use strict';

const sshBackend       = require('../ssh-backend');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('finix-latency-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'finix_latency_monitor';
const RISK_LEVEL = 'read';

/** Defaults — overridable via appliance.yaml tools.finix_latency_monitor. */
const DEFAULTS = {
  window_minutes:       60,
  slow_call_ms:         10000,
  medium_timeout_count: 4,
  high_timeout_count:   10,
  medium_slow_count:    8,
  medium_rate_pct:      20,
  high_rate_pct:        40,
  min_sample:           5,
};

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Scan the BaanBaan appliance logs (journalctl, baanbaan.service) over a ' +
    'recent window for Finix card-transfer latency: hard 30s timeouts, slow ' +
    'calls, and the resulting idempotency-retry 422 duplicates. The /api/status ' +
    'snapshot does not expose transfer latency, so this reads the [finix-api] ' +
    'POST /transfers result lines directly. Returns counts (transfer_calls, ' +
    'timeouts, slow_calls, succeeded, duplicate_422), timeout_rate_pct, ' +
    'max_duration_ms, and a severity (none/medium/high) derived from the ' +
    'configured thresholds. Read-only; never mutates the appliance.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge configured thresholds over DEFAULTS, coercing to finite numbers. */
function resolveConfig() {
  const cfg = getConfig().appliance?.tools?.finix_latency_monitor ?? {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(cfg[k]);
    if (Number.isFinite(v)) out[k] = v;
  }
  // Clamp the window to a sane, integer range — it is interpolated into the
  // journalctl command, so it must be a guaranteed-safe integer.
  out.window_minutes = Math.max(1, Math.min(1440, Math.round(out.window_minutes))) || 60;
  return out;
}

/**
 * Parse the [finix-api] POST /transfers result lines out of journalctl output.
 *
 * Each transfer attempt logs one line carrying "durationMs" plus either an
 * "error" (timeout / 422 duplicate) or a "state":"SUCCEEDED". Retries of a
 * timed-out original log their own lines, so transfer_calls counts attempts
 * (timeouts are the clean, unambiguous latency signal).
 *
 * A 30s client timeout doesn't mean the transfer failed — Finix usually
 * created it server-side and the appliance's idempotency-retry receives a 422
 * "Duplicate transfer TR<id>" telling it the in-flight transfer id. When that
 * same id later shows up with state=SUCCEEDED (immediate POST return, GET
 * status, or webhook-driven GET), the timeout was *recovered* and is not a
 * payment-impacting latency event — only a noisy customer-tap-was-slow signal.
 * `timeouts_recovered` counts those so the handler can subtract them from the
 * alarmable count. We pair a timeout with the nearest following 422-duplicate
 * line (terminal sales are serial per device, so order-based pairing is safe).
 *
 * @param {string} stdout
 * @param {number} slowMs
 * @returns {{ transfer_calls: number, timeouts: number, timeouts_recovered: number,
 *             slow_calls: number, succeeded: number, duplicate_422: number,
 *             max_duration_ms: number }}
 */
function parseFinixLines(stdout, slowMs) {
  const lines = String(stdout).split('\n');

  // Pass 1: collect every transfer id that reached SUCCEEDED in the window.
  // The state may appear on the original POST return, a follow-up GET, or
  // a webhook-driven GET — all are [finix-api] lines carrying transferId.
  const succeededIds = new Set();
  for (const line of lines) {
    if (!line.includes('[finix-api]') || !line.includes('"state":"SUCCEEDED"')) continue;
    const m = /"transferId":"(TR\w+)"/.exec(line);
    if (m) succeededIds.add(m[1]);
  }

  const isPostTransfer = (l) =>
    l.includes('[finix-api]') &&
    l.includes('"path":"/transfers"') &&
    l.includes('"method":"POST"');

  let transfer_calls = 0, timeouts = 0, timeouts_recovered = 0;
  let slow_calls = 0, succeeded = 0, duplicate_422 = 0, max_duration_ms = 0;

  // Pass 2: count, and for each timeout look forward to the next 422-duplicate
  // to learn the in-flight transfer id, then check it against succeededIds.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPostTransfer(line)) continue;

    transfer_calls++;

    const isTimeout = line.includes('The operation timed out.');
    const isDup422  = line.includes('Duplicate transfer') || line.includes('(422)');
    if (isTimeout) timeouts++;
    if (line.includes('"state":"SUCCEEDED"')) succeeded++;
    if (isDup422) duplicate_422++;

    const m = /"durationMs":(\d+)/.exec(line);
    if (m) {
      const d = parseInt(m[1], 10);
      if (d > max_duration_ms) max_duration_ms = d;
      // A hard timeout is already counted; count additional non-timeout slow
      // calls. The 422-duplicate retry returns in ~200ms — never "slow".
      if (!isTimeout && !isDup422 && d >= slowMs) slow_calls++;
    }

    if (!isTimeout) continue;

    // Look forward for the next POST /transfers line. If it's a 422-duplicate,
    // it's the idempotency-retry of THIS timeout (serial per terminal); read
    // the transfer id and check whether it ultimately succeeded.
    for (let j = i + 1; j < lines.length; j++) {
      if (!isPostTransfer(lines[j])) continue;
      const next = lines[j];
      const isNext422 = next.includes('Duplicate transfer') || next.includes('(422)');
      if (!isNext422) break; // a new sale began without a recovery retry — not recovered
      const tm = /Duplicate transfer (TR\w+)/.exec(next);
      if (tm && succeededIds.has(tm[1])) timeouts_recovered++;
      break;
    }
  }

  return { transfer_calls, timeouts, timeouts_recovered, slow_calls, succeeded, duplicate_422, max_duration_ms };
}

/**
 * Derive severity from the counts and the configured thresholds. Rate is only
 * applied once a minimum sample of calls exists, so 1/1 = 100% can't alarm.
 *
 * @returns {'none'|'medium'|'high'}
 */
function classifySeverity(counts, ratePct, cfg) {
  const rateEligible = counts.transfer_calls >= cfg.min_sample;

  if (counts.timeouts >= cfg.high_timeout_count) return 'high';
  if (rateEligible && ratePct >= cfg.high_rate_pct) return 'high';

  if (counts.timeouts >= cfg.medium_timeout_count) return 'medium';
  if (counts.slow_calls >= cfg.medium_slow_count) return 'medium';
  if (rateEligible && ratePct >= cfg.medium_rate_pct) return 'medium';

  return 'none';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<object>}
 */
async function handler() {
  const checkedAt = new Date().toISOString();
  const cfg       = resolveConfig();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run Finix latency monitor');
  }

  // window_minutes is a clamped integer (resolveConfig); safe to interpolate.
  const cmd =
    `journalctl -u baanbaan.service --since "${cfg.window_minutes} minutes ago" ` +
    `-o cat --no-pager 2>/dev/null | grep -F '[finix-api]' || true`;

  log.info(`Scanning baanbaan.service Finix transfers over the last ${cfg.window_minutes} min`);
  const result  = await sshBackend.exec(cmd);
  const counts  = parseFinixLines(result.stdout ?? '', cfg.slow_call_ms);

  // Severity ignores timeouts whose transfer was recovered via the
  // 422-idempotency-retry + webhook flow. Those are customer-tap-was-slow
  // signals, not payment-impacting latency. See parseFinixLines() for detail.
  const timeouts_unrecovered = Math.max(0, counts.timeouts - counts.timeouts_recovered);
  const ratePct = counts.transfer_calls > 0
    ? Math.round((timeouts_unrecovered / counts.transfer_calls) * 100)
    : 0;
  const alarmCounts = { ...counts, timeouts: timeouts_unrecovered };
  const severity = classifySeverity(alarmCounts, ratePct, cfg);

  const recoveredNote = counts.timeouts_recovered > 0
    ? ` (${counts.timeouts_recovered} of ${counts.timeouts} timeout(s) recovered via 422-idempotency)`
    : '';
  const summary = severity === 'none'
    ? `Finix transfers healthy: ${timeouts_unrecovered} unrecovered timeout(s) / ${counts.transfer_calls} call(s) ` +
      `over ${cfg.window_minutes} min${recoveredNote}.`
    : `Finix transfer latency elevated (${severity}): ${timeouts_unrecovered} unrecovered timeout(s), ` +
      `${counts.slow_calls} slow call(s), ${ratePct}% rate over ${cfg.window_minutes} min${recoveredNote}.`;

  log.info(summary);

  return {
    summary,
    severity,
    window_minutes:       cfg.window_minutes,
    transfer_calls:       counts.transfer_calls,
    timeouts:             counts.timeouts,
    timeouts_recovered:   counts.timeouts_recovered,
    timeouts_unrecovered: timeouts_unrecovered,
    slow_calls:           counts.slow_calls,
    succeeded:            counts.succeeded,
    duplicate_422:        counts.duplicate_422,
    timeout_rate_pct:     ratePct,
    max_duration_ms:      counts.max_duration_ms,
    checked_at:           checkedAt,
  };
}

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL, parseFinixLines, classifySeverity };
