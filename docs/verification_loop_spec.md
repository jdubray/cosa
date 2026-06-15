# Verification Loop Spec — Computational Re-Probe + LLM-as-Judge

**Status:** Draft
**Date:** 2026-06-14
**Owner:** cosa
**Scope:** New module `src/action-verifier.js` (computational re-probe), new module `src/session-judge.js` (LLM-as-judge), wiring in `src/orchestrator.js` (`processToolUse`) and `src/post-session-hook.js`, a new `verification` block in `config/appliance.yaml`, a `judge_verdict` column on the session row (`src/session-store.js`), and tests in `tests/action-verifier.test.js`, `tests/session-judge.test.js`, `tests/orchestrator-verify.test.js`.
**Out of scope:** Any change to `runbook-executor.js` convergence semantics (this spec generalises that idea into the LLM loop, it does not alter the deterministic path); any change to the security/approval gates; any BaanBaan source change.

---

## 1. Context

COSA is itself an agent harness: a SAM-based orchestration loop (`src/orchestrator.js`) wrapping Claude, with role-gated tools, an approval engine, output sanitisation, and data-driven monitors. Measured against the current literature on production harnesses, COSA already does the hard, safety-critical things well — permission enforcement is architecturally separate from model reasoning, retrieval is just-in-time, and monitors are data rows rather than code.

The one component COSA underinvests in is **verification** — the step that confirms an action actually achieved its objective before the agent reports success. The practitioner consensus (Boris Cherny: "giving the model a way to verify its work improves quality by 2–3×") is that this is the single highest-leverage harness addition, and it is the difference between a demo and a production agent.

Today COSA verifies in exactly one place: `runbook-executor.js` runs an optional read-only **convergence check** after a deterministic playbook (`conv.check_field === conv.expect_value`). But the *interactive, LLM-driven* path — the `action`-role sessions that actually restart services, kill runaways, and call mutating `appliance_api_call` endpoints — has **no equivalent**. Its "verification" is implicit: the model is trusted to look at the next turn's tool result and decide for itself whether it worked. Two concrete failure modes follow from that gap:

1. **Silent non-convergence.** An `action` session calls `appliance_api_call → restart_marketing_engine`, the call returns HTTP 200 ("restart accepted"), the model reports "Done — marketing engine restarted," and the session closes `complete`. But the service crash-looped on the way back up. Nothing re-checked health. The operator learns about it from the next cron probe, or from BaanBaan symptoms. This is the exact shape of the 2026-05-05 dual-process incident, where systemd and HTTP both "lied" and only a behavioural signal told the truth.

2. **Skill pollution.** `post-session-hook.js` auto-authors a skill whenever a session has ≥3 tool calls and `status === 'complete'`. But `status === 'complete'` only means *the loop terminated cleanly* — not that the incident was resolved. A session that flailed, ran six tools, fixed nothing, and produced a confident-sounding summary is currently indistinguishable from a genuine fix, and gets immortalised as a runbook-grade skill. Self-extending monitoring (Phase 2) amplifies whatever signal gates it; gating on "the loop didn't crash" is the wrong signal.

This spec closes both gaps with two composing layers, matching the literature's distinction between **computational verification** (deterministic ground truth) and **inferential verification** (semantic, LLM-as-judge):

- **Layer A — Computational re-probe (`action-verifier.js`).** After an `action`-role session executes a *mutating* tool, the orchestrator runs a configured **read-only probe** and appends the verdict to the `tool_result` the model sees on its next turn. The model gets deterministic ground truth *mid-loop* and can self-correct within its existing iteration budget — exactly the "return the outcome as a ToolMessage so the model can adjust" pattern.
- **Layer B — LLM-as-judge (`session-judge.js`).** After an `action` session closes, a cheap Haiku judge evaluates whether the session's objective was actually achieved, producing `{ verdict, confidence, reason }`. The verdict gates skill authoring, is persisted for audit, and (optionally) pages the operator when an action session is judged `unresolved`.

The two layers are independent and individually shippable. Layer A is the higher-value half and should land first.

## 2. Design principles

1. **Computational beats inferential — use it wherever a probe exists.** A read-only probe that reads the appliance's actual state is ground truth; an LLM verdict is a fallback for cases a probe can't express. Layer A is preferred; Layer B catches the semantic residue.
2. **Reuse the convergence contract, do not reinvent it.** Verification policies use the same `{ tool_name, check_field, expect_value }` shape as `runbook.convergence`, and reuse `resolveDotPath` from `runbook-executor.js`. One mental model for "did it work?", two call sites.
3. **The verifier is always read-only.** A verification probe must resolve to `risk: 'read'`. Enforced the same way `checkRunbookRisk` enforces it for convergence tools — a verifier that could mutate state is a config error and fails closed (no verification, log, never execute the non-read probe).
4. **Verification feeds the model, it does not overrule it.** Layer A appends a structured verdict to the `tool_result` content; it never blocks, never auto-retries the mutating tool, and never closes the session. The *model* decides what to do with "I restarted it but health is still degraded." This keeps the harness thin and the agency in the model.
5. **Opt-in per tool; default is no-op.** A mutating tool with no matching verification policy behaves exactly as today. Zero behaviour change until an operator writes a policy. No global "verify everything" switch.
6. **Verification is bounded.** A probe may re-attempt up to `max_attempts`, `settle_seconds` apart, to allow a service to come back up — but the total added wall-time per mutating call is capped (`max_attempts × settle_seconds`, hard-ceiled). A flaky probe must never wedge the loop.
7. **The judge gates authoring, not execution.** Layer B runs *after* the session in the fire-and-forget post-session hook. It can stop a bad skill being written and raise an alert; it can never delay or alter the operator-facing response.

## 3. Layer A — Computational re-probe

### 3.1 Where it hooks

In `src/orchestrator.js`, `processToolUse()` (currently lines ~156–300). After the existing **step 4** (sanitize → persist → truncate), and **only** when all of:

- the session `role === 'action'` (probe/query/audit are read-only by construction and have nothing to verify), and
- the executed tool's resolved `riskLevel !== 'read'` (only mutations need confirming), and
- the tool executed successfully (we did not already return an `is_error` result from a gate or a thrown handler), and
- a verification policy matches the call.

the orchestrator calls `actionVerifier.verify(...)` and **appends** its verdict block to the `content` string returned to the model. The mutating tool's own output is preserved verbatim above the verdict.

This is the only change to `processToolUse`: one guarded call near the end, appending to `content`. No change to the SAM acceptors, NAPs, or FSM — the verdict rides back to Claude as part of the normal `tool_result` turn, and the existing `makeCallClaudeNap` loops as usual, giving the model its self-correction turn for free.

### 3.2 Config — `config/appliance.yaml`

New top-level `verification:` block:

```yaml
verification:
  enabled: true
  # Computational re-probe policies (Layer A). Each policy matches a mutating
  # tool call and names a READ-ONLY probe whose result confirms the action.
  policies:
    - tool: appliance_api_call
      # Optional input match — only verify specific endpoints, not every call.
      when: { endpoint_name: restart_marketing_engine }
      probe:
        tool_name:    health_check
        check_field:  overall_status   # dot-path, resolved via resolveDotPath
        expect_value: healthy
        settle_seconds: 10             # wait before the first probe (service warm-up)
        max_attempts:   3              # re-probe up to N times, settle_seconds apart
    - tool: process_kill               # if/when a kill tool exists
      probe:
        tool_name:   resource_threshold_monitor
        check_field: summary
        expect_match: "within resource thresholds"   # substring match alt. to expect_value
        settle_seconds: 5
        max_attempts:   2
  # Hard ceiling on added wall-time per mutating call, regardless of policy.
  max_verify_seconds: 45
```

Matching rules (mirrors `resource_threshold_monitor` precedence conventions):

- A policy matches when `policy.tool === toolUse.name` **and**, if `policy.when` is present, every key in `when` deep-equals the corresponding `toolUse.input` field. Absent `when` matches any input.
- First matching policy wins (author most-specific first). At most one verification runs per mutating call.
- Exactly one of `expect_value` (strict `===`) or `expect_match` (substring containment, same convention as the monitor patterns) must be present.

### 3.3 Module — `src/action-verifier.js`

```js
'use strict';
const { getConfig }   = require('../config/cosa.config');
const toolRegistry    = require('./tool-registry');
const securityGate    = require('./security-gate');
const { resolveDotPath } = require('./runbook-executor');
const { resolveRisk } = require('./runbook-executor'); // export it; see §3.4
const { createLogger } = require('./logger');
const log = createLogger('action-verifier');

/** Find the first verification policy matching this tool call, or null. */
function matchPolicy(toolName, input) {
  const cfg = getConfig().appliance.verification ?? {};
  if (cfg.enabled === false) return null;
  for (const p of cfg.policies ?? []) {
    if (p.tool !== toolName) continue;
    if (p.when && !Object.entries(p.when).every(([k, v]) => input?.[k] === v)) continue;
    return p;
  }
  return null;
}

/**
 * Run the configured read-only probe for a just-executed mutating tool call.
 * Returns a verdict object; NEVER throws into the caller (failures degrade to
 * an 'inconclusive' verdict so the loop continues).
 *
 * @returns {Promise<null | {
 *   verified: boolean, status: 'confirmed'|'failed'|'inconclusive',
 *   probe: string, attempts: number, observed: unknown, expected: unknown,
 * }>}  null when no policy matches (caller appends nothing).
 */
async function verify(toolName, input) {
  const policy = matchPolicy(toolName, input);
  if (!policy) return null;

  const probe = policy.probe;

  // Principle 3: the probe MUST be read-only. Fail closed — never run a
  // non-read tool as a "verifier".
  const probeRisk = resolveRisk(probe.tool_name, probe.input ?? {});
  if (probeRisk !== 'read') {
    log.warn(`verification policy for "${toolName}" names non-read probe "${probe.tool_name}" (risk: ${probeRisk}) — skipping`);
    return { verified: false, status: 'inconclusive', probe: probe.tool_name, attempts: 0, observed: null, expected: probe.expect_value ?? probe.expect_match };
  }

  const cfg          = getConfig().appliance.verification ?? {};
  const maxAttempts  = Math.max(1, probe.max_attempts ?? 1);
  const settleMs     = Math.max(0, (probe.settle_seconds ?? 0) * 1000);
  const hardCeilMs   = (cfg.max_verify_seconds ?? 45) * 1000;

  const deadline = nowMs() + hardCeilMs;          // nowMs(): injectable clock (test seam)
  let attempts = 0, observed;

  for (let i = 0; i < maxAttempts; i++) {
    if (settleMs > 0) await sleepUntil(Math.min(nowMs() + settleMs, deadline));
    attempts++;
    try {
      const gate = await securityGate.check({ tool_name: probe.tool_name, input: probe.input ?? {}, risk_level: 'read' });
      if (gate.blocked) { observed = `[probe blocked: ${gate.reason}]`; break; }
      const result = await toolRegistry.dispatch(probe.tool_name, probe.input ?? {});
      observed = resolveDotPath(result, probe.check_field);
      const ok = probe.expect_match != null
        ? String(observed ?? '').includes(probe.expect_match)
        : observed === probe.expect_value;
      if (ok) return { verified: true, status: 'confirmed', probe: probe.tool_name, attempts, observed, expected: probe.expect_match ?? probe.expect_value };
    } catch (err) {
      observed = `[probe error: ${err.message}]`;
    }
    if (nowMs() >= deadline) break;
  }

  return {
    verified: false,
    status: observed == null || String(observed).startsWith('[') ? 'inconclusive' : 'failed',
    probe: probe.tool_name, attempts, observed,
    expected: probe.expect_match ?? probe.expect_value,
  };
}

module.exports = { verify, matchPolicy };
```

`nowMs`/`sleepUntil` are tiny injectable helpers so tests run without real delays.

### 3.4 Small supporting export

`runbook-executor.js` already implements `resolveRisk(toolName, input)` and `resolveDotPath` — add `resolveRisk` to its `module.exports` (it currently exports only `resolveDotPath`, `executeRunbook`, `RUNBOOK_FAILURE_CATEGORY`). One-line change, no behavioural impact.

### 3.5 Verdict formatting (what the model sees)

`processToolUse` appends to the `content` string returned for the mutating tool:

```
[output of appliance_api_call → restart_marketing_engine ...]

─── COSA VERIFICATION ───────────────────────────────────
Probe: health_check.overall_status
Expected: healthy   Observed: degraded   Attempts: 3   → NOT CONFIRMED
This action did NOT verify. Do not report success. Investigate, and
either retry, escalate, or tell the operator it is unconfirmed.
```

On `confirmed`:

```
─── COSA VERIFICATION ───────────────────────────────────
Probe: health_check.overall_status → healthy (confirmed in 1 attempt)
```

The instruction line on failure is deliberately imperative — it is the harness telling the model not to claim success. This text is appended *by the harness*, so unlike a tool's own output it is trusted and is **not** run through `sanitizeOutput`'s untrusted-text handling (it contains no appliance-sourced free text beyond the already-sanitised `observed` scalar, which is length-capped).

## 4. Layer B — LLM-as-judge

### 4.1 Where it hooks

In `src/post-session-hook.js`, inside `postSessionHook(...)`, before the skill-creation FSM block (currently lines ~310–410). The judge runs only when:

- `trigger.type !== 'email'` (operator conversations are not graded — the operator is the judge), and
- the session executed ≥ `judge.min_mutating_tools` mutating tool calls (a pure read/diagnostic session has no action to grade; gate is `1` by default), and
- `verification.judge.enabled === true`.

> **Implementation note (opt-in):** the judge gates on `enabled === true`, not `!== false`. This keeps the feature dormant unless explicitly configured, so it never fires in tests or the staging harness (which omit the `verification` block) — production enables it via `config/appliance.yaml`. A rollout-safety refinement from the draft's "default on", consistent with the watcher "disabled until soaked" convention.

### 4.2 Config (extends §3.2)

```yaml
verification:
  # ... Layer A fields ...
  judge:
    enabled: true
    model: claude-haiku-4-5-20251001
    min_mutating_tools: 1
    alert_on_unresolved: true      # email the operator on a 'unresolved' action session
```

### 4.3 Module — `src/session-judge.js`

A single forced-tool-call to Haiku (forced `tool_choice` for a structured verdict — far more reliable than parsing free-text JSON, per Anthropic tool-use guidance). The judge is given the session **objective** (`trigger.message`), the **tool calls + outcomes** (names, inputs, and — critically — any Layer-A verification verdicts already in the transcript), and the agent's **final text**, and must return one of three verdicts.

```js
const VERDICT_TOOL = {
  name: 'record_verdict',
  description: 'Record whether the session achieved its stated objective.',
  input_schema: {
    type: 'object',
    properties: {
      verdict:    { type: 'string', enum: ['resolved', 'unresolved', 'uncertain'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason:     { type: 'string', maxLength: 280 },
    },
    required: ['verdict', 'confidence', 'reason'],
  },
};

/**
 * Grade a completed action session. Best-effort: any failure (API error, no
 * tool_use block) returns { verdict: 'uncertain', confidence: 0, reason: ... }
 * so the caller's gating logic has a safe, well-defined default.
 */
async function judgeSession({ objective, toolCalls, finalText, apiKey, model }) { /* ... */ }
```

Prompt shape (system): *"You are a strict QA reviewer for an autonomous ops agent. Given the objective and what the agent actually did, decide whether the objective was achieved. Prefer 'unresolved' or 'uncertain' over a charitable 'resolved'. Computational verification verdicts in the transcript are ground truth — if a re-probe says NOT CONFIRMED, the objective is not resolved regardless of what the agent's summary claims. Call record_verdict exactly once."*

The "computational verdict is ground truth" instruction makes Layer B defer to Layer A where both ran, so they never disagree in the agent's favour.

### 4.4 Consumers of the verdict

1. **Persist.** Add a nullable `judge_verdict` TEXT column to the session row (`src/session-store.js` schema + a `recordJudgeVerdict(sessionId, verdict)` writer). Stored as e.g. `unresolved:0.82`. Auditable via the existing session search path.
2. **Gate skill authoring.** In `post-session-hook.js`, the `searching → generating` transition (currently gated only on `status === 'complete'`, line ~347) gains a second condition: generate a skill **only** when `verdict === 'resolved'`. A `resolved` session that lacks a matching skill still authors one; an `unresolved`/`uncertain` session sends `not_novel` and writes nothing. This directly fixes the skill-pollution failure mode (§1.2). For the *existing-skill* branch (`recordSkillUse`), pass `success = (verdict === 'resolved')` instead of `status === 'complete'`, so skill success-rate degradation reflects real outcomes, not clean exits.
3. **Alert on silent failure.** When `judge.alert_on_unresolved` and `verdict === 'unresolved'` on an action session, raise a `createAlert({ category: 'unresolved_action', severity: 'high', ... })` and email the operator — the same path `runbook-executor.js` uses for non-convergence. This is the post-hoc safety net for actions that had no Layer-A policy.

## 5. Acceptance criteria

**Layer A — `action-verifier.js`:**

1. `matchPolicy` returns the first policy whose `tool` matches and whose `when` fields all deep-equal the input; returns `null` when `verification.enabled === false`, when no `tool` matches, or when `when` mismatches.
2. `verify` against a probe whose `resolveDotPath(result, check_field)` equals `expect_value` returns `{ verified: true, status: 'confirmed', attempts: 1 }`.
3. `verify` against a probe that never matches across `max_attempts` returns `{ verified: false, status: 'failed' }` with `attempts === max_attempts`.
4. `verify` returns `{ status: 'confirmed' }` if attempt 2 of 3 matches after attempt 1 missed (re-probe loop works; stops early on first success).
5. `verify` with a non-read probe (`resolveRisk !== 'read'`) does **not** dispatch the probe and returns `status: 'inconclusive'` with `attempts: 0`, plus a warning log.
6. `verify` honours `expect_match` (substring) as an alternative to `expect_value` (strict equality).
7. `verify` respects `max_verify_seconds`: with `max_attempts: 10, settle_seconds: 30` and a 45 s ceiling, it makes at most 2 attempts (injected clock; no real sleeping in the test).
8. `verify` returns `null` (no-op) when no policy matches — caller appends nothing.

**Orchestrator wiring — `orchestrator.js`:**

9. An `action`-role session executing a mutating tool with a matching policy appends the `─── COSA VERIFICATION ───` block to that tool's `tool_result.content`; the tool's own output is preserved above it.
10. A `probe`/`query`/`audit`-role session, or an `action` session executing a `read`-risk tool, appends **nothing** (verifier not called).
11. A mutating tool that returned an `is_error` result (blocked by a gate or threw) is **not** verified.
12. A `failed`/`inconclusive` verdict appends the imperative "Do not report success" instruction; a `confirmed` verdict appends the one-line confirmation.

**Layer B — `session-judge.js` + hook:**

13. `judgeSession` returns the verdict from the forced `record_verdict` tool call on the happy path.
14. `judgeSession` returns `{ verdict: 'uncertain', confidence: 0 }` on API error or when the response contains no `tool_use` block (safe default).
15. `post-session-hook` skips the judge for `trigger.type === 'email'` and for sessions with `< min_mutating_tools` mutating calls.
16. A session judged `resolved` with no existing matching skill authors a skill (existing behaviour, now additionally gated); a session judged `unresolved` or `uncertain` authors **no** skill even when `status === 'complete'` and tool-call count ≥ minimum.
17. `recordSkillUse` for an existing-skill match is called with `success = (verdict === 'resolved')`.
18. `judge_verdict` is persisted on the session row; an `unresolved` action session with `alert_on_unresolved: true` creates an `unresolved_action` alert and emails the operator.

## 6. Worked example — the 2026-05-05 dual-process shape

An `action` session is triggered to restart the marketing engine. It calls `appliance_api_call → restart_marketing_engine`; the endpoint returns `{ status: "accepted" }`.

- **Without this spec:** the model reports "marketing engine restarted," session closes `complete`, a skill is authored, operator hears nothing. The crash-loop is found hours later.
- **With Layer A:** after the call, the verifier waits 10 s and runs `health_check`; `overall_status` is `degraded`; it re-probes 3× and still `degraded`. The `NOT CONFIRMED` block is appended to the tool result. On its next turn the model sees ground truth, does **not** claim success, and either retries with a different approach or tells the operator the restart is unconfirmed — within the same session, no new trigger needed.
- **With Layer B:** even if Layer A had no policy for this endpoint, the judge reads the objective ("restart marketing engine") against the outcome, returns `unresolved`, suppresses skill authoring, and raises an `unresolved_action` alert. The operator is paged in minutes, not hours.

## 7. Non-goals (deferred)

- **Auto-retry / auto-remediation on a failed verdict.** Layer A reports; it never re-fires the mutating tool itself. Closing the loop autonomously would re-enter the approval/business-hours gates and belongs in a separate spec.
- **Visual verification (screenshots).** The literature's third verification mode (Playwright screenshots) is irrelevant to a headless ops appliance.
- **Token-budget termination.** The orchestrator caps *iterations* (`MAX_ITER_BY_ROLE`) but not *tokens*. A separate, smaller spec should add token-budget exhaustion as an explicit termination condition; the re-probe loop here is bounded by wall-time and attempts, so it does not depend on it.
- **Structured error taxonomy / retry-with-backoff.** Transient-vs-recoverable error classification (IMAP, Anthropic API, appliance HTTP) is a related harness hardening, tracked separately.
- **Judging cron/probe sessions.** Only action sessions are graded; read-only probes have monitor thresholds as their ground truth already.

## 8. Rollout

Two commits on `main`, Layer A first (it carries most of the value and has no schema migration):

**Commit 1 — Layer A:**
- `src/action-verifier.js` — new module.
- `src/runbook-executor.js` — export `resolveRisk` (one line).
- `src/orchestrator.js` — guarded `verify` call + verdict append in `processToolUse`.
- `config/appliance.yaml` — `verification.policies` block (start with the single `restart_marketing_engine` policy; expand as endpoints are characterised).
- `tests/action-verifier.test.js`, `tests/orchestrator-verify.test.js` — AC1–AC12.

**Commit 2 — Layer B:**
- `src/session-judge.js` — new module.
- `src/session-store.js` — `judge_verdict` column + `recordJudgeVerdict`.
- `src/post-session-hook.js` — judge call + skill-gating + alert wiring.
- `config/appliance.yaml` — `verification.judge` block.
- `tests/session-judge.test.js` + post-session-hook test updates — AC13–AC18.

`package.json` / `package-lock.json` ride the next tag bump per the tag-first policy. After deploy, run one real `action` session against a benign verifiable endpoint to confirm the verdict block renders and the judge column populates before relying on the skill-gating change.
