---
name: operator-report
title: Operator Status Report
description: Compose a concise plain-text status report and send it to the operator email address
domain: communication
---

## Steps

1. Gather findings from the current session (health, services, disk, alerts).
2. Open the report with the overall status on line 1: "Appliance healthy." or "Alert: <issue>."
3. Follow with a bulleted summary — one line per finding, most severe first.
4. For each finding include: metric name, current value, threshold, and status (OK / WARNING / CRITICAL).
5. If remediation is needed, end with a clearly labelled "Recommended action:" section.
6. Keep the report under 300 words; operators read on mobile.
7. Use plain text only — no markdown, no HTML.
8. Send via `emailGateway.sendEmail` using the operator address from appliance config.

## Experience
