# COSA Full Code Review — 2026-05-18

Scope: `src/**/*.js` (~18.5k LOC, 57 files).
Focus per `/goal`: (1) defects, (2) enhancements, (3) places where the Claude API is invoked for what is effectively deterministic string formatting and should become a status template — reserve AI for analysis only.

The gold standard for "template, not LLM" is already in the codebase: `runCredentialAuditTask` at `src/cron-scheduler.js:1879`. It runs the tool, builds the alert mechanically from the JSON output, and never calls Claude. Several other cron tasks should follow the same pattern.

---

## A. LLM → Template conversions (the headline finding)

| Class | Tasks | Action |
|---|---|---|
| **A — genuine analysis, keep AI** | `health_check`, `backup`/`backup_verify`, `archive_check`, `internet_ip_watch`, `tunnel_health_check`, `unit_health`, `resource_threshold_monitor`, `auto_patch_*`, `credential_audit` (already converted) | None |
| **B — strong template candidates** | `shift_report`, `weekly_digest`, `security_digest`, `pci_assessment`, `compliance_verify`, `webhook_hmac_verify`, `jwt_secret_check`, `token_rotation_remind` | Replace LLM session with mechanical render |
| **C — hybrid (keep AI for triage, template the alert body)** | `git_audit`, `process_monitor`, `network_scan`, `access_log_scan` | Skip Claude on clean runs (already done in some); when escalating, build `ips_alert` payload deterministically instead of asking the LLM to compose it |

### Why this matters now

- `shift_report` already has a deterministic renderer (`formatShiftReportBody()`). Its trigger builder is essentially **dead code** — Haiku is asked to stringify data we've already stringified.
- `weekly_digest` and `security_digest` are fixed-shape multi-section reports (HEALTH / BACKUPS / ANOMALIES / SKILLS / OPERATOR ACTIVITY and 8 sections respectively). The "intelligence" is just filling counts into headings. **Highest hallucination risk for least benefit.**
- `compliance_verify` extracts `fail_count` / `warning_count` from tool JSON, derives status mechanically, and the session adds nothing. Same for `webhook_hmac_verify` and `jwt_secret_check`.

### Migration template

Mirror `runCredentialAuditTask`:

```js
async function runWeeklyDigestTask() {
  const data = await collectWeeklyDigestData();           // tool / session_search / DB
  const subject = `[COSA] Weekly Digest: week of ${weekOf}`;
  if (await wasRecentlySent(WEEKLY_DIGEST_CATEGORY)) return;
  const body = renderWeeklyDigest(data);                  // pure function, no LLM
  await emailGateway.send({ subject, body });
  await recordSent(WEEKLY_DIGEST_CATEGORY);
}
```

The renderer is a pure function (`src/renderers/weekly-digest.js`) — easy to unit-test with golden snapshots, no flakiness, no hallucination, no API cost.

### Order of attack

1. `shift_report` — trivial, renderer already exists, drop the trigger builder.
2. `compliance_verify`, `webhook_hmac_verify`, `jwt_secret_check`, `token_rotation_remind` — small, fixed-shape, very low risk.
3. `weekly_digest`, `security_digest` — bigger renderers (~150 LOC each) but the biggest hallucination-risk wins.
4. `pci_assessment` — 13 SAQ-A requirements; rigid structure but more fields.
5. C-class (`git_audit` et al.): keep AI triage; just stop asking Claude to compose the `ips_alert` JSON.

Estimate: ~2 days of focused work to eliminate 5–8 Haiku sessions/week and remove the bulk of "the digest invented a fingerprint" risk.

---

## B. Defects

### P0 — fix before next quiet weekend

| # | File:line | Issue | Trigger |
|---|---|---|---|
| 1 | `src/cron-scheduler.js:2453-2454` | `cron.schedule()` callback fires `fn()` (async) without awaiting; no `_running` mutex on any task | A slow task overlaps its next tick → concurrent runs → duplicate alerts, session-store contention |
| 2 | (all ~25 schedules) | No concurrency guard on any cron task | Same as #1; reproduced any time a task exceeds its interval (`internet_ip_watch` every 2 min is the most exposed) |
| 3 | `src/ssh-backend.js` (post-fix `82eff1c`) | Verify the new error/close handling doesn't break the existing "no more than one concurrent reconnect timer" invariant under repeated error→close→error sequences | Multiple appliance flaps within one backoff window |

P0 #1 + #2 are one fix: a small `withMutex(name, fn)` wrapper applied to every `schedule(name, cron, fn)` call. Logs "skipped — prior run still in progress" on conflict.

### P1 — should fix soon

| # | File:line | Issue |
|---|---|---|
| 4 | `src/email-gateway.js:492` | `await client.logout().catch(() => {})` swallows IMAP logout errors silently; connection state then unknown |
| 5 | `src/security-fsm.js:346` | `runRespondingNap().catch(...)` is fire-and-forget; if `cloudflare_kill` / `ips_alert` fail, the FSM stays in "responding" forever |
| 6 | `src/cron-scheduler.js` (config cache) | `getConfig()` is cached at boot; edits to `appliance.yaml` are invisible until process restart, with no warning |
| 7 | `src/tools/db-query.js:190-198` | `Promise.race` against a timeout; loser branch leaves the SSH exec stream running on the appliance — orphan process per timed-out query |
| 8 | `src/email-gateway.js:111-112` | `_pollInterval = setInterval(...)` has no `stop()` exported; SIGTERM leaves IMAP polling alive during shutdown |
| 9 | `src/security-fsm.js:258-273` | 15-min `alertTimeoutHandle.unref()` can fire during a long orchestrator session and prematurely escalate to "responding" — possibly a spurious `cloudflare_kill` |

### P2 — opportunistic

| # | File:line | Issue |
|---|---|---|
| 10 | `src/watcher-registry.js:277-281` | `last_alerted_at` is read once before run; concurrent `runAll()` invocations see the same stale value → duplicate watcher alerts despite cooldown |
| 11 | `src/approval-engine.js:471,498` | `msg.from` interpolated into log lines unchecked — log injection via crafted From: header |
| 12 | `src/tools/restart-appliance.js:81-109` | Service-name regex catches injection attempts, but the rejection log echoes the unsanitized string |
| 13 | `src/watcher-registry.js:136-167` | Prepared sqlite statements cached but never finalized (only matters for tests / dynamic reloads) |
| 14 | `src/tools/appliance-status-poll.js:129` | Watcher runs not killed on tool timeout — orphan child processes accumulate over hours |
| 15 | `src/email-gateway.js:251-252` | Malformed SUPPRESS replies silently dropped — operator never told why their suppression didn't take |
| 16 | `src/cron-scheduler.js:682` | `sed` key-update relies on `|` not appearing in value; corner case |

---

## C. Enhancements

### Quick wins (< 30 min each)

1. **Extract shell-quote helper.** Three copies: `cron-scheduler.js:21-23`, `tools/backup-verify.js:63-65`, `tools/backup-run.js:68-70` → `src/shell-utils.js`.
2. **Classify SSH errors at the source.** Currently timeout / ECONNRESET / auth-fail all log identically. Parse `err.code` in `ssh-backend.exec()` and emit `[module] SSH timeout (Xms)` / `auth failed` / `host unreachable`. Saves 30 minutes per overnight incident.
3. **Add "task skipped because dedup" log lines.** Several cron tasks return silently when dedup says "already sent". Add an `info`-level log so a maintainer can tell "ran and was suppressed" from "didn't run at all".
4. **Move scattered timeouts/dedup windows into `appliance.yaml`.** `ALERT_DEDUP_WINDOW_MS`, `SHIFT_REPORT_DEDUP_WINDOW_MS`, `APT_TIMEOUT_MS`, `EXEC_MAX_BUFFER`. Today they require code edits.

### Medium (half-day)

5. **`scripts/fire-cron-task.js <name>` runner.** Today we had to write a one-off inline `node -e` script to manually re-fire `credential_audit` after the SSH outage. Export `fireCronTask(name)` from `cron-scheduler.js` and wire up a CLI. Will be used again.
6. **`AlertBuilder` class.** ~40 hand-built alert objects across `cron-scheduler.js` with no shared shape policy. A builder gives one place to enforce required fields and a single severity-string spelling.
7. **`log.alert(severity, msg)` convenience.** Maps critical→error, high/medium→warn, low→info. Today the same severity gets logged at different levels across modules.

### Larger (multi-day)

8. **Centralize tool paths in `appliance.yaml`.** `DEFAULT_REPO_PATH`, `DEFAULT_BACKUP_DIR`, `DEFAULT_LOG_PATH`, `DEFAULT_MERCHANT_DB` are duplicated as constants across 5+ tool files. Any path change today touches every one.
9. **"Silent success" observability sweep.** Several cron tasks log nothing on healthy runs. Wrap each `schedule(name, cron, fn)` in an executor that always emits a one-line `[task] ok` / `[task] alerts=N` at the end. Pairs naturally with the mutex wrapper from P0.
10. **Audit test mocks for tautology.** Tests like `ssh-backend.test.js` and `email-gateway.test.js` mock the client wholesale and then assert the mock was called — they verify call signatures, not behavior. Higher-value targets are the reconnect path, IMAP flow under error/close races, and orchestrator session timeouts.

---

## D. Suggested first PR

A single focused PR with high leverage:

1. P0 #1+#2 — add a `withMutex` wrapper around every `schedule(...)` call. ~20 LOC + tests.
2. P1 #8 — export `stop()` from `email-gateway.js`, call it in the shutdown path.
3. Quick win #2 — classify SSH error codes.
4. Quick win #5 — `scripts/fire-cron-task.js`.
5. Headline migration — convert **`shift_report`** to a pure template (lowest risk, renderer already exists).

That bundle removes the largest concurrency hazard, eliminates one shutdown wart, fixes the next-incident log-greppability problem, and proves the LLM→template migration on the easiest target before tackling the digests.
