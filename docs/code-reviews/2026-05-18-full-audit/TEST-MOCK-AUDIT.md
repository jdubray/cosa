# Test-Mock Tautology Audit — 2026-05-18

Companion to `REVIEW.md` §C Larger #10. Identifies tests that assert on mock invocations rather than observable behavior — tests that would pass even if the production code did nothing meaningful.

Read-only backlog. None of these need fixing today; they're a punch list for "the next time someone has an afternoon to harden a specific subsystem."

## Categories

- **HIGH** — would pass even with the production code commented out
- **MEDIUM** — mock-call assertions dominate but at least one behavioral check exists
- **LOW** — healthy behavioral coverage; mock-call checks are sanity belts

---

## HIGH PRIORITY

### `tests/ssh-backend.test.js:293-308`
Command timeout test asserts only on `mockLastStream.destroy` invocation. A production bug where the stream is destroyed but the rejection is silently swallowed would pass this test.
**Fix:** assert that the `exec()` promise rejects with a timeout error.

### `tests/cron-scheduler.test.js:155-187`
`AC1 — cron registration` asserts `mockCronSchedule` was called and `typeof callback === 'function'`, but never invokes the callback. A no-op callback would satisfy this.
**Fix:** invoke the callback and assert on its observable side effects (emails sent, state changed).

### `tests/email-gateway.test.js:573-587`
Asserts `ImapFlow` was constructed with an object that mirrors the test-provided config. If production code accidentally ignored config and used hard-coded values, the test would fail only because the mock won't see them — not because the behavior is wrong.
**Fix:** spy on the real config getter, or assert on downstream behavior (`connect()` called, mailbox opened).

### `tests/cron-scheduler-phase3.test.js:282-292`
Asserts `trigger.source === 'git-audit'` and that the message string mentions `ips_alert`, but never verifies the trigger is actually passed to the orchestrator or that the message drives any decision.
**Fix:** assert that `mockRunSession` was called with the trigger, or that the handler actually consumes the message.

### `tests/cron-scheduler-security-digest.test.js:404-410`
"runWeeklySecurityDigestTask no longer goes through the orchestrator" asserts the orchestrator was NOT called and that `mockSendEmail` was called once. But the email content is itself mocked, so no real template renders. Calling the orchestrator AND sending an email would still pass.
**Fix:** assert on the email's `text` field — substring matches for `Weekly Security Digest`, `GIT AUDIT`, etc.

---

## MEDIUM

### `tests/cron-scheduler.test.js:258-289` — AC2 trigger message
Verifies trigger keywords without confirming `runSession` actually receives the trigger.
**Fix:** assert that `mockRunSession` was invoked with the exact trigger object.

### `tests/email-gateway.test.js:532-565` — AC8 messages-marked-as-READ
Only assertion is `mockImapMessageFlagsAdd` was called. Doesn't verify the flag took effect.
**Fix:** stub `messageFlagsAdd` to fail and verify rejection bubble, OR assert subsequent state.

### `tests/cron-scheduler-phase3.test.js:294-329` — alert creation
Asserts on `mockCreateAlert` call; because the mock no-ops, no alert actually reaches the database. A code path that constructs the alert but fails to persist it would pass.
**Fix:** mock `createAlert` to return a fake ID and verify subsequent `findRecentAlert` retrieves the same ID.

### `tests/ssh-backend.test.js:325-336` — AC5 key reading
Mixed: lines 326–330 are pure mock plumbing; lines 332–335 are behavioral (`isConnected()`).
**Fix:** merge into one test that confirms the connection is live AND the key was read.

---

## LOW (no action needed)

| File:lines | Why it's healthy |
|---|---|
| `tests/email-gateway.test.js:259-319` | Mock assertions subordinate to behavioral checks (logs, message structure). |
| `tests/cron-scheduler.test.js:534-568` | Lifecycle tests tied to real state transitions (registered → stopped → re-registered). |
| `tests/cron-scheduler-security-digest.test.js:266-289` | Footer-date assertions test the real date-arithmetic function. |
| `tests/ssh-backend.test.js:185-197, 203-218, 229-265` | Pure-function and state tests; mock calls absent or secondary. |

---

## Summary

| Severity | Count |
|---|---|
| HIGH (tautological) | 5 |
| MEDIUM | 4 |
| LOW (healthy) | 7 |

The high-priority issues cluster around four patterns:
1. **Callback/closure testing without invocation** (cron-scheduler AC1, ssh-backend timeout)
2. **Config propagation tests that mirror test setup** (email-gateway ImapFlow constructor)
3. **Trigger/message construction verified in isolation** (cron-scheduler AC2, cron-scheduler-phase3 trigger source)
4. **Mocked side effects without downstream state checks** (security-digest mock bypass, alert creation without persistence verification)

These represent ~8% of the mock-assertion lines across the flagged files, concentrated at integration points where behavior matters most. Worth fixing alongside any future change to the affected modules — not standalone.
