---
name: ssh-health-check
title: SSH Health Check
description: Run a broad health check on the appliance over SSH and summarise findings
domain: monitoring
---

## Steps

1. Connect to the appliance via SSH.
2. Run `health_check` tool to collect CPU, memory, disk, and service status.
3. Parse the structured JSON result.
4. Compare each metric against its threshold (CPU > 90 %, memory > 85 %, disk > 80 %).
5. If all metrics are within thresholds, report "Appliance is healthy."
6. If any metric exceeds its threshold, flag it as a warning and include the value.
7. If a service is reported as down, escalate to the operator immediately.
8. Return the summary in plain text — lead with the overall status.

## Experience
