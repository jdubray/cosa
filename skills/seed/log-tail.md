---
name: log-tail
title: Log Tail and Analysis
description: Retrieve recent log entries from the appliance and surface errors or anomalies
domain: diagnostics
---

## Steps

1. Use `db_query` or SSH to read the last 200 lines of the relevant log file.
2. If the log path is not specified, default to `/var/log/syslog` and the appliance application log.
3. Scan lines for severity keywords: `ERROR`, `CRITICAL`, `FATAL`, `OOM`, `segfault`, `panic`.
4. Group matching lines by keyword and time window (within the last hour vs earlier).
5. If no error keywords found: report "No anomalies in recent logs."
6. For each error group, quote the first and last matching line to bound the incident window.
7. Do not include raw log data in emails; summarise only.
8. If the log file is unreadable or missing, note it explicitly in the report.

## Experience
