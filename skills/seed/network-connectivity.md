---
name: network-connectivity
title: Network Connectivity Check
description: Verify that the appliance can reach essential upstream endpoints and report any connectivity failures
domain: networking
---

## Steps

1. Use SSH to run connectivity probes: `ping -c 3 8.8.8.8` and `curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com`.
2. Check local DNS resolution: `nslookup api.anthropic.com`.
3. If all probes succeed: report "Network connectivity nominal."
4. If ping fails but curl succeeds: note ICMP may be blocked — not necessarily an issue.
5. If the Anthropic API endpoint is unreachable, flag this as a critical connectivity issue since it blocks COSA operation.
6. If DNS resolution fails, check `/etc/resolv.conf` and report the configured nameservers.
7. Do not modify network configuration without operator approval.
8. Include round-trip times in the report to help the operator assess latency.

## Experience
