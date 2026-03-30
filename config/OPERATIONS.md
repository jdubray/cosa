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

## Known Quirks

(None recorded yet. Operator may add appliance-specific notes here.)
