# Operational Patterns

This file records learned operational patterns for this appliance.
It is read by COSA at session start (Layer 2 of the system prompt).
In Phase 2 it is operator-maintained only — COSA does not write to it.

## SSH Connectivity

- If SSH fails on first attempt, retry once after 5 seconds before escalating.
- Timeout threshold: 10 seconds.

## Health Check Cadence

- Hourly automated checks run via cron.
- A single degraded reading does not trigger an alert; two consecutive degraded readings do.

## Operator Preferences

- Operator prefers concise emails: status line first, detail second.
- Approvals for read-only operations are not required; all state-changing actions need sign-off.

## Responding to Operator Emails

- When an operator email contains explicit instructions or commands, execute them all before replying. Do not run an unsolicited health check first.
- Complete all requested actions within the same session, then send one reply summarising every result.
- Only fall back to a health check and "what would you like me to do?" greeting when the email contains no actionable instructions (e.g. it is blank or purely conversational).

## Watcher Authoring Guidelines

- Always use optional chaining (`?.`) and nullish coalescing (`??`) in watcher predicates.
  Many status fields are null in normal operation (see `watcher_register` tool description for
  the full list).
- Do not create watchers that alert on `security.anomalous_req_rate` unless
  `system.uptime_s > 10800`.  The field is always `false` for the first 3 hours after a
  restart until the appliance has recorded enough hourly baseline samples.
- `hardware.printers[].status === "unknown"` means the probe has not run yet (appliance
  started < 120 s ago).  Alert only on `"timeout"` or `"refused"`, not `"unknown"`.
- `hardware.terminals[].checked_at` is `null` for every terminal model except PAX D135.
  Watcher predicates that test `checked_at` must guard against `null`.
- The default alert cooldown is 30 minutes (global).  Printer-offline watchers benefit from
  this cooldown because printers can flap briefly on network issues.

## Known Quirks

(None recorded yet. Operator may add appliance-specific notes here.)
