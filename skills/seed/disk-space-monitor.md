---
name: disk-space-monitor
title: Disk Space Monitor
description: Check disk usage on all mounted filesystems and alert if any exceeds the warning threshold
domain: monitoring
---

## Steps

1. Run `health_check` tool and extract the `disk` section from the result.
2. For each filesystem, read `used_percent`.
3. If `used_percent` >= 90: critical — send an immediate operator alert.
4. If `used_percent` >= 80: warning — include in the session summary.
5. If all filesystems are below 80 %: report "Disk usage nominal."
6. Always include the top filesystem by usage in the summary line.
7. If a filesystem cannot be read, note it as unavailable rather than failing silently.

## Experience
