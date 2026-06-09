# Approval durability across restart — spec

**Status:** Proposed (design only)
**Owner:** COSA security
**Source:** Full security review, 2026-06-09 (email gateway finding #8)
**Related:** `src/approval-engine.js`, `src/session-store.js` (`approvals` table),
`src/cron-scheduler.js`, `src/runbook-executor.js`

---

## 1. Current behaviour (grounded in code)

`requestApproval()` (`approval-engine.js:337`) does three things:
1. Persists a row to `approvals` with `status='pending'` and an `expires_at`.
2. Emails the operator the `APPROVE-<token>` instructions.
3. Returns a **Promise the calling orchestrator session blocks on**. The
   `resolve` callback lives only in the in-memory `_pending` map
   (`approval-engine.js:405–419`), keyed by `approval_id`.

On an operator reply, `processInboundReply()` (`:433`) looks up the row by token,
drives the in-memory FSM, updates the DB, and emails confirmation.

**What happens on a process restart while an approval is outstanding:**
- The `approvals` row survives (`status='pending'`).
- `_pending` is empty — the Promise and, critically, the **entire orchestrator
  session that was awaiting it** are gone.
- A reply that arrives post-restart hits the `!intents` branch (`:467–491`) and
  the operator gets a "Session Gone — action NOT executed" email.

This is **fail-closed and replay-safe today:**
- The action is never executed without a live session to run it.
- `updateApprovalStatus(..., 'pending'-guarded)` plus the `status !== 'pending'`
  check (`:450`) make double-actioning a token a no-op.

So the gap is **not** a security hole. It is (a) state-consistency hygiene —
orphaned `pending` rows linger until a reply or the cron sweep touches them — and
(b) a resilience gap for unattended (cron/watcher) actions, which *could* survive
a restart but currently don't.

## 2. Why "persist the FSM" is the wrong frame

The FSM is already backed by the DB row. The thing that cannot be rehydrated is
the **blocked caller**: an interactive orchestrator session is mid-`await`, mid
tool-dispatch, holding context that is not serialised anywhere. Resuming it would
mean checkpointing arbitrary LLM-session state — out of scope and risky. For
interactive sessions, **fail-closed on restart is the correct behaviour** and
should stay.

The durability win is specifically for **deterministic, origin-cron/watcher
actions**, where "the action" is a named runbook step, not a live LLM turn — that
*can* be re-derived after restart.

## 3. Proposed work

### 3.1 Boot-time reconciliation sweep (do first — pure hygiene)
On startup, before polling resumes, sweep `approvals` for `status='pending'`
rows with no live `_pending` entry (all of them, since `_pending` starts empty):

- If `expires_at` is in the past → mark `expired` (`resolved_by='system:boot-sweep'`).
- If still within the window but the **origin was an interactive session** → mark
  `orphaned` (new terminal status; `resolved_by='system:restart'`) and email the
  operator a single consolidated "these requests were dropped by a restart" note
  instead of one-off "Session Gone" emails per late reply.
- If still within the window and the **origin was cron/watcher** → eligible for
  §3.2 (durable re-execution) instead of orphaning.

Emit one summary log + at most one operator email. Idempotent (safe to run every
boot).

### 3.2 Durable approvals for unattended actions (the real resilience win)
Add an explicit, persisted approval→execution decoupling for cron/watcher-origin
requests:

- Tag each approval row with `origin` (`interactive` | `cron` | `watcher`) and,
  for unattended ones, the action needed to execute on approval — ideally a
  **runbook name + trigger context** rather than a serialised tool call, so
  execution reuses `runbook-executor` (which already enforces risk policy and the
  security gate).
- When the operator approves an unattended request, mark it
  `approved_pending_exec`. A boot-time + each-poll executor picks up
  `approved_pending_exec` rows and runs them via `runbook-executor`, then marks
  `executed`. This survives restart: approval and execution are no longer tied to
  one live process.
- Re-validate at execution time: re-check expiry, re-run `checkRunbookRisk`, and
  honour the business-hours read-only window (so a stale approval can't fire a
  mutating step into a now-forbidden window).

### 3.3 Schema changes (`approvals`)
- `origin TEXT NOT NULL DEFAULT 'interactive'`
- `runbook_name TEXT` (nullable; set for unattended actions)
- `trigger_ctx TEXT` (nullable JSON)
- New statuses: `orphaned`, `approved_pending_exec`, `executed`, `exec_failed`.
- Index on `status` already exists; add one on `(status, expires_at)`.

### 3.4 Keep the existing safety properties
- Interactive-session approvals remain fail-closed on restart (no resume).
- Token replay stays a no-op (status guard).
- 128-bit tokens, quiet-hours, and rate-limiting are unchanged.

## 4. Test plan
- Boot sweep: pending+expired → `expired`; pending+interactive+in-window →
  `orphaned` + one summary email; pending+cron+in-window → left for §3.2. Sweep is
  idempotent across two consecutive boots.
- Durable path: approve an unattended request, "restart" (drop `_pending`), run
  the executor → action runs once, row → `executed`. Re-run executor → no second
  execution (idempotent).
- Execution-time re-validation: approved unattended action whose window has since
  become business-hours → blocked, row → `exec_failed` with reason.
- Replay: same token actioned twice → single state change.
- Regression: existing `approval-engine` / `t-2.7` suites stay green.

## 5. Rollout
1. §3.1 boot reconciliation + `orphaned` status — small, pure hygiene, ship first.
2. §3.3 schema migration (additive; default `origin='interactive'` keeps current
   behaviour for all existing rows).
3. §3.2 durable unattended execution — the larger piece; land behind the schema
   once §3.1 is proven.

**Validation note:** all of this touches `session.db` (better-sqlite3), so it must
be developed/tested where the native module is built (the Pi or CI) — it cannot be
run on the Windows dev box used for the review remediation.

## 6. Effort
§3.1: small (a sweep function + one status + a migration). §3.2: medium (schema +
executor wiring + re-validation + tests). No change to the interactive approval
path, which stays fail-closed by design.
