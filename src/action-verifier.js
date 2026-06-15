'use strict';

/**
 * Action verifier — computational re-probe (Verification Loop spec, Layer A).
 *
 * After an `action`-role session executes a *mutating* tool, the orchestrator
 * asks this module to confirm the action actually achieved its objective by
 * running a configured READ-ONLY probe and comparing its result against an
 * expected value. The verdict is appended to the `tool_result` the model sees
 * on its next turn, giving it deterministic ground truth mid-loop so it can
 * self-correct within its existing iteration budget.
 *
 * This generalises the deterministic convergence check already used by
 * `runbook-executor.js` (same `{ tool_name, check_field, expect_value }`
 * contract, same `resolveDotPath`/`resolveRisk` helpers) into the interactive
 * LLM loop. The verifier NEVER mutates state, NEVER blocks, and NEVER closes
 * the session — it only reports.
 *
 * Config lives under `appliance.verification` in `config/appliance.yaml`.
 */

const { getConfig }                  = require('../config/cosa.config');
const toolRegistry                   = require('./tool-registry');
const securityGate                   = require('./security-gate');
const { resolveDotPath, resolveRisk } = require('./runbook-executor');
const { createLogger }               = require('./logger');

const log = createLogger('action-verifier');

/** Default wall-time ceiling for one verification, if not set in config. */
const DEFAULT_MAX_VERIFY_SECONDS = 45;

// Injectable clock seam — overridden in tests so re-probe loops run instantly.
function _realNow() { return Date.now(); }
function _realSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Policy matching
// ---------------------------------------------------------------------------

/**
 * Find the first verification policy matching a tool call.
 *
 * A policy matches when `policy.tool === toolName` and, if `policy.when` is
 * present, every key in `when` strict-equals the corresponding `input` field.
 * First match wins (author most-specific first). Returns null when verification
 * is disabled or nothing matches.
 *
 * @param {string} toolName
 * @param {object} input
 * @returns {object|null}
 */
function matchPolicy(toolName, input) {
  const cfg = getConfig().appliance.verification ?? {};
  if (cfg.enabled === false) return null;
  const src = input ?? {};
  for (const policy of cfg.policies ?? []) {
    if (policy.tool !== toolName) continue;
    if (policy.when && !Object.entries(policy.when).every(([k, v]) => src[k] === v)) continue;
    return policy;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Run the configured read-only probe for a just-executed mutating tool call.
 *
 * Best-effort: probe faults (errors, security-gate blocks) degrade to an
 * `inconclusive` verdict rather than throwing, so the agent loop continues.
 *
 * @param {string} toolName - Name of the mutating tool that just ran.
 * @param {object} input    - Input the mutating tool was called with.
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} [opts]
 *   Injectable clock for tests; defaults to real time.
 * @returns {Promise<null | {
 *   verified: boolean,
 *   status:   'confirmed'|'failed'|'inconclusive',
 *   probe:    string,
 *   field:    string,
 *   attempts: number,
 *   observed: unknown,
 *   expected: unknown,
 * }>}  null when no policy matches (caller appends nothing).
 */
async function verify(toolName, input, opts = {}) {
  const policy = matchPolicy(toolName, input);
  if (!policy) return null;

  const now   = opts.now   ?? _realNow;
  const sleep = opts.sleep ?? _realSleep;
  const probe = policy.probe ?? {};
  const expected = probe.expect_match != null ? probe.expect_match : probe.expect_value;

  // Principle 3: a verifier MUST be read-only. Fail closed — never run a
  // non-read tool as a "verifier" (a config error must not mutate state).
  const probeRisk = resolveRisk(probe.tool_name, probe.input ?? {});
  if (probeRisk !== 'read') {
    log.warn(
      `verification policy for "${toolName}" names non-read probe ` +
      `"${probe.tool_name}" (risk: ${probeRisk}) — skipping verification`
    );
    return {
      verified: false, status: 'inconclusive', probe: probe.tool_name,
      field: probe.check_field, attempts: 0, observed: null, expected,
    };
  }

  const cfg         = getConfig().appliance.verification ?? {};
  const maxAttempts = Math.max(1, probe.max_attempts ?? 1);
  const settleMs    = Math.max(0, (probe.settle_seconds ?? 0) * 1000);
  const hardCeilMs  = (cfg.max_verify_seconds ?? DEFAULT_MAX_VERIFY_SECONDS) * 1000;

  const deadline = now() + hardCeilMs;
  let attempts = 0;
  let observed;

  for (let i = 0; i < maxAttempts; i++) {
    // Settle delay (let the service come back up) — but never past the ceiling.
    if (settleMs > 0) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(settleMs, remaining));
    }

    attempts++;
    try {
      const gate = await securityGate.check({
        tool_name: probe.tool_name, input: probe.input ?? {}, risk_level: 'read',
      });
      if (gate.blocked) {
        observed = `[probe blocked: ${gate.reason}]`;
        break;
      }
      const result = await toolRegistry.dispatch(probe.tool_name, probe.input ?? {});
      observed = resolveDotPath(result, probe.check_field);
      const ok = probe.expect_match != null
        ? String(observed ?? '').includes(probe.expect_match)
        : observed === probe.expect_value;
      if (ok) {
        return {
          verified: true, status: 'confirmed', probe: probe.tool_name,
          field: probe.check_field, attempts, observed, expected,
        };
      }
    } catch (err) {
      observed = `[probe error: ${err.message}]`;
    }

    if (now() >= deadline) break;
  }

  // A probe fault (never got a real reading) is 'inconclusive'; a real reading
  // that simply didn't match the expectation is 'failed'.
  const probeFaulted = observed == null
    || (typeof observed === 'string' && observed.startsWith('['));

  return {
    verified: false,
    status:   probeFaulted ? 'inconclusive' : 'failed',
    probe:    probe.tool_name,
    field:    probe.check_field,
    attempts,
    observed,
    expected,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const _HEADER = '─── COSA VERIFICATION ───────────────────────────────────';

/**
 * Render a verdict as the block appended to the model-facing tool_result.
 *
 * A `confirmed` verdict is a single reassuring line. A `failed`/`inconclusive`
 * verdict carries an imperative instruction: this is the harness telling the
 * model not to claim success. Because the harness authors this text it is
 * trusted and does not pass through output sanitisation (the only embedded
 * appliance-sourced value is the already length-bounded `observed` scalar).
 *
 * @param {{ status: string, probe: string, field?: string, attempts: number,
 *           observed: unknown, expected: unknown }} v
 * @returns {string}
 */
function formatVerdict(v) {
  const ref = v.field ? `${v.probe}.${v.field}` : v.probe;

  if (v.status === 'confirmed') {
    const plural = v.attempts === 1 ? '' : 's';
    return `${_HEADER}\nProbe: ${ref} → ${String(v.observed)} (confirmed in ${v.attempts} attempt${plural})`;
  }

  const word = v.status === 'failed' ? 'NOT CONFIRMED' : 'INCONCLUSIVE';
  return [
    _HEADER,
    `Probe: ${ref}`,
    `Expected: ${String(v.expected)}   Observed: ${String(v.observed)}   Attempts: ${v.attempts}   → ${word}`,
    'This action did NOT verify. Do not report success. Investigate, and either',
    'retry, escalate, or tell the operator the outcome is unconfirmed.',
  ].join('\n');
}

module.exports = { verify, matchPolicy, formatVerdict };
