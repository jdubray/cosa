# H5 — Security-gate hardening: from fail-open denylist to enforced allowlist

**Status:** Proposed (design only — no code in this doc)
**Owner:** COSA security
**Source:** Full security review, 2026-06-09 (finding H5)
**Related:** `src/security-gate.js`, `src/orchestrator.js`, `src/runbook-executor.js`, `config/appliance.yaml`

---

## 1. Problem

The security gate (`src/security-gate.js`) is presented as a two-layer
pre-execution defense, but in production only a weak layer is live:

1. **Tirith scanner — absent and fail-open.** The binary is described in-code as
   "aspirational (no released binary)" (`security-gate.js:80`). When absent,
   `tirithAvailable=false` and Step 1 is skipped entirely. Even when present,
   *every* error path — timeout, crash, missing stdin, any non-`1` exit —
   resolves `{ blocked: false }` (lines 154–166). So a scanner fault silently
   disables the scan.

2. **Dangerous-command regex denylist — the only live layer.** Step 2 matches
   config patterns against `JSON.stringify(toolCall.input)`
   (`security-gate.js:202–220`). Denylists are bypassable by construction, the
   match target is LLM-controlled, and a malformed pattern in config is silently
   `continue`d past (lines 213–215), quietly shrinking coverage.

Net: the gate is a **tripwire, not a boundary**. That is acceptable *if* the
real boundary is elsewhere and the gate's limits are explicit. Today the limits
are implicit and the gate is over-trusted.

## 2. Goals / non-goals

**Goals**
- Make the *enforced* boundary explicit and independent of any undeployed binary.
- Fail **closed** for high/critical-risk tool calls when a scanner is *configured
  as required* but unavailable/erroring.
- Make denylist config errors loud, not silent.
- Keep read-only and routine medium-risk flows fast (no new approval friction).

**Non-goals**
- Shipping Tirith itself (separate effort). This spec makes its absence safe.
- Replacing the role gate or approval engine — those stay the primary boundary.

## 3. The real boundary (already mostly in place)

The gate is layer 3 of a defense-in-depth stack; the enforced boundary is the
first two, which already fail closed:

1. **Role gate** (`orchestrator.js:167`, `tool-registry.js:145`): unknown role →
   read-only; a read-only role can never dispatch a mutating tool. Keep as-is.
2. **Approval gate** (`approval-engine.js`): high/critical always require explicit
   operator approval; H1 fix now also forces approval for self-authored
   unattended automation. Keep as-is.
3. **Per-tool argument validation**: the strongest, most reliable control — see §4.

## 4. Proposed work

### 4.1 Per-tool argument allowlists (primary)
Mutating tools must validate their *semantic* arguments against an allowlist, not
rely on the gate to catch bad input. Several already do this well — adopt it
uniformly:

- `restart_appliance` / `pause_appliance`: service name ∈ configured set
  (already regex-validated; tighten to an explicit allowlist of known services).
- `db_query`: SELECT-only, no semicolons, destructive-keyword blocked, stdin
  delivery (already implemented — the model to copy).
- `appliance_api_call`: endpoint ∈ `api_endpoints` allowlist (already implemented).
- `settings_write`: key ∈ configured allowlist (already implemented).
- **Action:** audit every tool with `riskLevel` ≥ medium for an explicit
  allowlist/validator; add one where missing. Track in a checklist in the PR.

### 4.2 Scanner availability policy (fail-closed when required)
Add `security.scanner_required` (default `false`) to `appliance.yaml`.

- `scanner_required: false` (today's behaviour): scanner absent → skip; runtime
  error → fail-open (availability over strictness). Log at `info`.
- `scanner_required: true`: for tool calls whose resolved `riskLevel` is
  `high`/`critical`, a scanner that is absent **or** errors → **block** with a
  clear reason. Read/medium calls still proceed (so the box isn't bricked if the
  scanner dies). This lets an operator opt into strict mode once Tirith ships.

### 4.3 Loud denylist config errors
`security-gate.js:213–215` currently `continue`s past a malformed
`dangerous_commands` pattern. Change to: log at `error`, increment a startup
"degraded gate" counter, and surface it in the security digest so a typo can't
silently remove a rule. Optionally fail boot in a `--strict-config` mode.

### 4.4 Documentation
Update the gate's module docstring to state plainly: "tripwire over LLM-chosen
tool input; the enforced boundary is the role gate + approval gate + per-tool
argument validation." Removes the false sense of a two-layer wall.

## 5. Test plan
- Unit: `scanner_required:true` + absent scanner + high-risk call → blocked;
  + read/medium call → allowed. Runtime error → blocked for high, allowed for read.
- Unit: malformed `dangerous_commands` pattern → `error` log + degraded counter,
  other patterns still enforced.
- Per-tool: each ≥medium tool rejects an out-of-allowlist argument.
- Regression: existing gate tests (`tests/security-gate.test.js`) stay green.

## 6. Rollout
1. §4.3 + §4.4 (no behaviour change, pure hardening/clarity) — ship first.
2. §4.1 audit + fill gaps — ship per-tool.
3. §4.2 behind `scanner_required:false` default — enable in strict mode only once
   Tirith (or a replacement scanner) is actually deployed and documented in
   `setup.js`.

## 7. Effort
Small–medium. §4.3/§4.4 are hours. §4.1 is an audit plus a few validators. §4.2
is a focused change in `security-gate.check()` + config plumbing. No
architectural rewrite.
