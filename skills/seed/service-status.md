---
name: service-status
title: Service Status Check
description: Verify that all critical appliance services are running and report any that are stopped or degraded
domain: monitoring
---

## Steps

1. Run `health_check` tool and extract the `services` array from the result.
2. Partition services into `running` and `not_running` groups.
3. If all services are running: report "All services operational."
4. For each non-running service, record the service name and last-known status.
5. If any critical service is down (e.g. `pos-adapter`, `nginx`, `postgres`): escalate immediately.
6. For non-critical stopped services: include in the summary but do not escalate.
7. Never attempt to restart a service without explicit operator approval.
8. Return the full service list in the report so the operator can verify independently.

## Experience
