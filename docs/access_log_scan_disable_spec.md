# Access-Log Scan Disable Spec

**Status:** Draft
**Date:** 2026-04-27
**Owner:** cosa
**Scope:** `src/cron-scheduler.js`, `tests/cron-scheduler-phase3.test.js`
**Out of scope:** BaanBaan appliance code — **do not modify under any circumstances.** This change is entirely cosa-side. The `access_log_scan` tool source (`src/tools/access-log-scan.js`) and its unit tests are also untouched — the tool stays in the registry and remains usable for any future appliance that does have an HTTP access log; we are only stopping the *scheduled* invocation against this LAN-only appliance and stopping the digest from emitting a misleading "tool not available" line.

---

## 1. Problem

The 2026-04-27 weekly security digest email contained:

```
ACCESS LOG ANOMALIES
Note: Access log scanning is not available in current toolset.
Manual review of SSH and HTTP access logs is recommended.
```

This message is **misleading**: the tool is registered and runs every 8 hours, but on this appliance there's nothing for it to scan, and the digest prompt asks Claude to look up session results that never exist.

## 2. Root cause (verified on baanbaan@192.168.1.248, 2026-04-27)

| Probe | Result |
|---|---|
| `/var/log/nginx/access.log` | does not exist (no nginx) |
| `/var/log/auth.log` | does not exist (host is journald-only) |
| `/var/log/baanbaan/` | only `mem-check.log` and `mem-trend.log`, both stale since 2026-03-12 |
| `journalctl _COMM=sshd --since "7 days ago"` matching `Failed|Invalid|fail` | **0** |
| `/etc/ssh/sshd_config` | `PasswordAuthentication no`, `PermitRootLogin no` (key-only) |
| Bun listeners | `127.0.0.1:3000` (loopback) and `*:3100` (LAN) — no internet exposure |
| `appliance.yaml` `tools.access_log_scan.enabled` | `false` |
| `cron-scheduler.js:1737` schedule call | runs **unconditionally**, ignores the flag |
| `buildWeeklySecurityDigestTrigger` step 4 | unconditionally tells Claude to search `access_log` results |

Net effect: scheduler runs an empty 8-hourly task, never produces an `access_log_scan` session, and the digest prompt produces an "ACCESS LOG ANOMALIES" section that Claude has to fill in from nothing — generating the misleading boilerplate.

## 3. Threat-surface read

Building a real log scanner here would be low ROI:

- **SSH brute force:** key-only auth makes password guessing impossible. Journal confirms 0 failed-auth events in 7 days.
- **HTTP attacks:** Bun on `*:3100` is reachable on the cafe LAN only — not internet-routable. The MAC-watching `network_scan` cron is the upstream control for "someone unknown joins WiFi and probes."
- **Auth log scanner:** would generate a "0 events in 7 days" report indefinitely.

We're not adding a substitute scanner. The fix is purely about removing a misleading line and an unproductive cron tick.

## 4. Fix — cosa-side only

### 4.1 Honor `tools.<key>.enabled === false` at registration time

In `cron-scheduler.js`'s `start()`, change the inline `schedule()` helper so it consults `appliance.tools?.[key]?.enabled` and skips registration when the flag is exactly `false`:

```js
const schedule = (key, defaultExpr, fn) => {
  if (appliance.tools?.[key]?.enabled === false) {
    log.info(`Cron skipped (disabled in appliance.yaml): ${key}`);
    return;
  }
  const expr = cronConfig[key] ?? defaultExpr;
  const task = cron.schedule(expr, () => {
    fn().catch(err => log.error(`${key} task error: ${err.message}`));
  });
  _tasks.set(key, task);
  log.info(`Cron registered: ${key} (${expr})`);
};
```

Semantics:
- Strict `=== false` — missing/`undefined` is treated as "enabled" (preserves current default-on behavior for tools that don't appear under `tools:`).
- Cron names that don't correspond to a tool key (e.g. `health_check_lunch`) are unaffected because `appliance.tools.health_check_lunch` is undefined.
- This generalizes; today only `access_log_scan` benefits, but any future flag-off tool will be honored automatically.

### 4.2 Branch the digest prompt on the same flag

`buildWeeklySecurityDigestTrigger` becomes:

```js
function buildWeeklySecurityDigestTrigger() {
  const weekOf = _getMondayDateString();
  const { appliance } = getConfig();
  const accessLogEnabled = appliance.tools?.access_log_scan?.enabled !== false;

  const accessLogStep = accessLogEnabled
    ? '4. Run session_search with query "access_log anomaly threat brute" for the past 7 days.'
    : '4. Skip — access log scanning is disabled for this appliance (no public web frontend; SSH is key-only). Do not run session_search for access_log.';

  const accessLogSection = accessLogEnabled
    ? '- Section: ACCESS LOG ANOMALIES — mark ✓ if none, or ⚠ with count and top threat categories'
    : '- Section: ACCESS LOG ANOMALIES — render exactly: "N/A — appliance is LAN-only with key-only SSH; no web frontend"';

  // ...rest of the message uses ${accessLogStep} and ${accessLogSection}
}
```

Rationale: the section is preserved (for visual continuity in the email), but its content reflects reality. Claude is told a concrete fact instead of being left to invent boilerplate when the search comes up empty.

## 5. Acceptance criteria

1. Calling `start()` with `appliance.tools.access_log_scan.enabled = false` registers **no** cron task for `access_log_scan` (verified by inspecting `_tasks` or `mockCronSchedule` calls).
2. Calling `start()` with the flag missing or `true` still registers the cron at `0 */8 * * *`.
3. `buildWeeklySecurityDigestTrigger().message` with the flag `false` does **not** contain the substring `session_search with query "access_log` and **does** contain `N/A — appliance is LAN-only`.
4. Same call with the flag `true` (or default) **does** contain the access_log session_search instruction (regression guard for non-BaanBaan appliances).
5. Existing AC4 access_log_scan tests still pass — the tool itself, `runAccessLogScanTask`, and `buildAccessLogScanTrigger` are unchanged. The change is purely about whether `start()` registers it and how the digest prompt is built.
6. Re-running the weekly digest under the BaanBaan config produces a digest body with `ACCESS LOG ANOMALIES\nN/A — ...` instead of the old "Note: Access log scanning is not available in current toolset" boilerplate.

## 6. Non-goals

- Building an SSH brute-force / journald scanner. (0 events in 7 days; key-only auth; not worth the maintenance.)
- Adding a Bun request-log parser. (Internet-unreachable port; LAN MAC-watching is the upstream control.)
- Removing `access_log_scan.js` or its tool registration in `main.js`. The tool remains available for ad-hoc invocation and for future appliances that have nginx.
- Bumping any other tool's `enabled` semantics. We only document and honor `=== false`; existing default-on behavior is preserved for everything else.

## 7. Rollout

Single commit on `main`:
- `src/cron-scheduler.js` — `schedule()` guard + digest-prompt branching
- `tests/cron-scheduler-phase3.test.js` — new tests covering AC1–AC4
- `docs/access_log_scan_disable_spec.md` — this spec

`package.json` / `package-lock.json` bump rides on the next commit per the tag-first versioning policy. The next tag will be `release/v1.1.5`.

After deploy, the next 13:00 UTC tick (now noisy-empty) will simply not run. The next Monday-2am digest will render the clean ACCESS LOG ANOMALIES section.
