'use strict';

const { getConfig }    = require('../config/cosa.config');
const toolRegistry     = require('./tool-registry');
const runbookStore     = require('./runbook-store');
const securityGate     = require('./security-gate');
const emailGateway     = require('./email-gateway');
const { createAlert }  = require('./session-store');
const { createLogger } = require('./logger');

const log = createLogger('runbook-executor');

const RUNBOOK_FAILURE_CATEGORY = 'runbook_failure';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-notation path against an object, e.g.
 * `resolveDotPath(r, 'process.running')` → `r?.process?.running`.
 *
 * @param {object} obj
 * @param {string} path
 * @returns {unknown} the value, or undefined if any segment is missing.
 */
function resolveDotPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Resolve a tool's effective risk level, mirroring the orchestrator's dynamic
 * resolution: `appliance_api_call` is registered as `'dynamic'`, and the real
 * risk depends on the chosen endpoint (resolved from the appliance allowlist).
 *
 * @param {string} toolName
 * @param {object} input
 * @returns {string} resolved risk level
 */
function resolveRisk(toolName, input) {
  const risk = toolRegistry.getRiskLevel(toolName);
  if (risk !== 'dynamic') return risk;
  const endpointName = input?.endpoint_name;
  const entry = (getConfig().appliance?.appliance_api?.api_endpoints ?? [])
    .find(e => e.name === endpointName);
  // Unknown endpoint → fail closed (treat as high), never auto-approve.
  return entry ? (entry.risk ?? 'high') : 'high';
}

/**
 * Risk policy for deterministic execution. Returns a human-readable reason
 * string if the runbook may NOT run, or null if it is permitted.
 *
 * Rules:
 *   - A `critical`-risk step may never run deterministically (no unattended
 *     restart/kill/pause), regardless of auto_approved.
 *   - A non-read step requires `auto_approved` (operator pre-authorisation).
 *   - The convergence tool must be read-only — a verification check must never
 *     mutate state.
 *
 * @param {object[]} steps
 * @param {object|null} conv
 * @param {boolean} autoApproved
 * @returns {string|null}
 */
/**
 * Current hour (0–23) in the configured appliance timezone. Mirrors the
 * approval-engine helper (hourCycle 'h23' avoids the "24"-at-midnight quirk on
 * some runtimes; falls back to UTC if the tz is invalid).
 *
 * @param {string} tz
 * @returns {number}
 */
function _localHour(tz) {
  try {
    return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()), 10);
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * True when the POS is within its configured business hours, during which the
 * operator policy forbids any non-read action against the appliance — even an
 * auto_approved one. Driven by `appliance.business_hours { start, end }`
 * (local 24-h clock, [start, end) with overnight wrap). Absent or start===end
 * disables the gate (back-compat / tests).
 *
 * @returns {boolean}
 */
function _withinBusinessHours() {
  const { appliance } = getConfig();
  const bh = appliance.appliance?.business_hours;
  if (!bh || bh.start == null || bh.end == null || bh.start === bh.end) return false;
  const h = _localHour(appliance.appliance?.timezone ?? 'UTC');
  return bh.start < bh.end ? (h >= bh.start && h < bh.end) : (h >= bh.start || h < bh.end);
}

function checkRunbookRisk(steps, conv, autoApproved) {
  for (const step of steps) {
    const risk = resolveRisk(step.tool_name, step.input ?? {});
    if (risk === 'critical') {
      return `step "${step.tool_name}" is critical-risk and may never run in a runbook`;
    }
    if (risk !== 'read' && _withinBusinessHours()) {
      return `step "${step.tool_name}" is non-read (risk: ${risk}) but the POS is within business hours — actions are forbidden in the read-only window`;
    }
    if (risk !== 'read' && !autoApproved) {
      return `step "${step.tool_name}" is non-read (risk: ${risk}) but the runbook is not auto_approved`;
    }
  }
  if (conv) {
    const crisk = resolveRisk(conv.tool_name, conv.input ?? {});
    if (crisk !== 'read') {
      return `convergence tool "${conv.tool_name}" must be read-only (risk: ${crisk})`;
    }
  }
  return null;
}

/**
 * Dispatch a tool through the security gate (Tirith / dangerous-command scan)
 * before execution — the same pre-execution guard the interactive orchestrator
 * applies. Deterministic execution skips the *approval* gate (that's what
 * auto_approved authorises), but never the *security* gate.
 *
 * @param {string} toolName
 * @param {object} input
 * @returns {Promise<object>} tool result
 * @throws {Error} `code:'SECURITY_GATE_BLOCKED'` if the gate blocks the call.
 */
async function dispatchGuarded(toolName, input) {
  const gate = await securityGate.check({ tool_name: toolName, input });
  if (gate.blocked) {
    const reason = gate.pattern ? `${gate.reason} [pattern: ${gate.pattern}]` : gate.reason;
    const err = new Error(`blocked by security gate: ${reason}`);
    err.code = 'SECURITY_GATE_BLOCKED';
    throw err;
  }
  return toolRegistry.dispatch(toolName, input);
}

/**
 * Email the operator that a runbook did not converge / was aborted, and record
 * an alert row.  Best-effort: failures here are logged, not thrown.
 *
 * @param {string} name
 * @param {object} triggerCtx
 * @param {Array} stepsLog
 * @param {string} outcome - 'failed' | 'aborted'
 * @param {string} [reason]
 */
async function sendRunbookFailureAlert(name, triggerCtx, stepsLog, outcome, reason) {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator?.email;
  const applianceName = appliance.appliance?.name ?? appliance.name ?? 'COSA appliance';

  const title = `${applianceName} — Runbook "${name}" ${outcome}`;
  const body = [
    `Runbook "${name}" ${outcome === 'aborted' ? 'was aborted' : 'did not converge'}.`,
    reason ? `Reason: ${reason}` : null,
    '',
    `Trigger: ${JSON.stringify(triggerCtx)}`,
    '',
    'Steps log:',
    JSON.stringify(stepsLog, null, 2),
    '',
    'Operator intervention required.',
    '',
    '--- Automated alert from COSA ---',
  ].filter(l => l !== null).join('\n');

  try {
    if (operatorEmail) {
      await emailGateway.sendEmail({ to: operatorEmail, subject: `[COSA Alert] ${title}`, text: body });
    }
    createAlert({
      session_id: null,
      severity:   'critical',
      category:   RUNBOOK_FAILURE_CATEGORY,
      title,
      body,
      sent_at:    new Date().toISOString(),
      email_to:   operatorEmail ?? null,
    });
  } catch (err) {
    log.warn(`[runbook] failed to send failure alert for "${name}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a stored runbook deterministically — dispatching each step's tool
 * via the registry with **no LLM call**.  After the steps run, an optional
 * convergence check decides success; the loop repeats up to `max_iterations`.
 *
 * Safety: non-read steps may only run when the runbook was authored with
 * `auto_approved: true` (operator pre-authorisation).  A runbook that contains
 * a non-read step without that flag is aborted before any step runs, because
 * the deterministic path bypasses the interactive approval gate.
 *
 * @param {string} name
 * @param {object} triggerCtx - watcher/trigger context, stored for audit.
 * @returns {Promise<{ outcome: string, converged: boolean|null, iterations: number, stepsLog: Array }>}
 * @throws {Error} `code:'RUNBOOK_NOT_FOUND'` if the runbook does not exist.
 */
async function executeRunbook(name, triggerCtx) {
  const runbook = runbookStore.get(name);
  if (!runbook) {
    const err = new Error(`Runbook not found: "${name}"`);
    err.code  = 'RUNBOOK_NOT_FOUND';
    throw err;
  }

  let steps, conv;
  try {
    steps = JSON.parse(runbook.steps);
    conv  = runbook.convergence ? JSON.parse(runbook.convergence) : null;
  } catch (parseErr) {
    // Stored steps/convergence are written via JSON.stringify, so this only
    // fires on row corruption — fail with a clear, coded error.
    const err = new Error(`Runbook "${name}" has corrupt JSON: ${parseErr.message}`);
    err.code  = 'RUNBOOK_CORRUPT';
    throw err;
  }
  const autoApproved = runbook.auto_approved === 1;
  const maxIterations = runbook.max_iterations;

  const runId = runbookStore.logRun({ runbook_name: name, trigger_ctx: JSON.stringify(triggerCtx ?? {}) });

  // ── Pre-flight risk policy: critical steps are never allowed; non-read steps
  //    require auto_approved; the convergence tool must be read-only. ──────────
  const riskReason = checkRunbookRisk(steps, conv, autoApproved);
  if (riskReason) {
    log.warn(`[runbook] "${name}" aborted before execution — ${riskReason}`);
    runbookStore.updateRun(runId, { outcome: 'aborted', finished_at: new Date().toISOString() });
    await sendRunbookFailureAlert(name, triggerCtx, [], 'aborted', riskReason);
    return { outcome: 'aborted', converged: null, iterations: 0, stepsLog: [] };
  }

  let stepsLog       = [];
  let converged      = null;
  let lastStepFailed = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    stepsLog = [];
    let stepFailed = false;

    for (const [i, step] of steps.entries()) {
      try {
        const result = await dispatchGuarded(step.tool_name, step.input ?? {});
        stepsLog.push({ step: i, tool: step.tool_name, result, ts: new Date().toISOString() });
      } catch (err) {
        stepsLog.push({ step: i, tool: step.tool_name, error: err.message, ts: new Date().toISOString() });
        stepFailed = true;
        break;
      }
    }

    lastStepFailed = stepFailed;
    runbookStore.updateRun(runId, { steps_log: JSON.stringify(stepsLog), iterations: iter + 1 });

    if (stepFailed) {
      if (runbook.on_failure === 'abort') {
        runbookStore.updateRun(runId, { outcome: 'aborted', finished_at: new Date().toISOString() });
        await sendRunbookFailureAlert(name, triggerCtx, stepsLog, 'aborted', 'a step threw and on_failure=abort');
        return { outcome: 'aborted', converged: null, iterations: iter + 1, stepsLog };
      }
      // on_failure='alert': do NOT run the convergence check on a broken pass;
      // retry the next iteration. If steps still fail at the cap, the outcome
      // below resolves to 'failed' (never a false 'success').
      continue;
    }

    if (conv) {
      try {
        const checkResult = await dispatchGuarded(conv.tool_name, conv.input ?? {});
        const actual = resolveDotPath(checkResult, conv.check_field);
        converged = actual === conv.expect_value;
      } catch (err) {
        log.warn(`[runbook] "${name}" convergence check threw: ${err.message}`);
        converged = false;
      }
      runbookStore.updateRun(runId, { converged: converged ? 1 : 0 });
      if (converged) break;
    } else {
      // No convergence check — a single clean pass through the steps is the contract.
      converged = null;
      break;
    }
  }

  // A thrown step that exhausted its retries (on_failure='alert') is a failure,
  // not a success — even with no convergence check.
  const outcome = (lastStepFailed || converged === false) ? 'failed' : 'success';
  runbookStore.updateRun(runId, { outcome, finished_at: new Date().toISOString() });

  if (outcome === 'failed') {
    const reason = lastStepFailed
      ? 'a step threw and could not complete (on_failure=alert)'
      : 'convergence not reached within max_iterations';
    await sendRunbookFailureAlert(name, triggerCtx, stepsLog, 'failed', reason);
  }

  const iterations = runbookStore.getRun(runId)?.iterations ?? stepsLog.length;
  log.info(`[runbook] "${name}" complete — outcome=${outcome} converged=${converged} iterations=${iterations}`);

  return { outcome, converged, iterations, stepsLog };
}

module.exports = { executeRunbook, resolveDotPath, RUNBOOK_FAILURE_CATEGORY };
