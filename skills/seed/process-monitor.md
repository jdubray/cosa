---
name: process-monitor
title: Process Monitor
description: Inspect running processes on the appliance and flag any unexpected or resource-heavy processes
domain: diagnostics
---

## Steps

1. Use `health_check` tool; extract the `top_processes` or `cpu` section if available.
2. Alternatively, use SSH to run `ps aux --sort=-%cpu | head -20`.
3. Identify any process consuming more than 80 % CPU or 70 % memory.
4. Check whether the top processes are expected appliance processes.
5. If an unknown process is in the top 5 by CPU, flag it for operator review.
6. Never kill a process without explicit operator approval — even if it appears stuck.
7. If a known critical process (e.g. `postgres`, `nginx`) is absent from the list, escalate.
8. Report the top 5 processes by CPU in the summary with name, PID, and CPU %.

## Experience
