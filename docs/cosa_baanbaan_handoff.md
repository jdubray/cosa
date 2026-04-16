I have everything I need from reading the spec and implementation. No further reads required.

---

## COSA Integration Handoff — `GET /api/status`

**BaanBaan appliance version:** 2.11.0  
**Spec reference:** `cosa-monitoring-spec.md` v1.1

---

### 1. The Endpoint Is Ready

`GET /api/status` is fully implemented across all four phases:

| Phase | What it adds |
|-------|-------------|
| A | Core snapshot: store, orders, payments, hardware, system, security, errors |
| B | Live printer TCP probe — background service, results cached in memory |
| C | Structured `payment_errors` table — `recent_errors` and `terminal_errors_24h` populated |
| D | Anomalous request rate — hourly `req_per_min` baseline with median threshold |

---

### 2. Authentication

- **Auth type:** Bearer JWT, identical to all other merchant API routes
- **Key type required:** `cloud`-scoped API key in the `api_keys` table
- **How to provision:** Create an API key for the merchant with `key_type = 'cloud'` via the merchant setup flow. COSA exchanges this for a short-lived JWT and includes it as `Authorization: Bearer <token>` on every poll.
- **No role check** is enforced beyond a valid token — any `cloud`-scoped key grants read access to the full snapshot.

---

### 3. Network Access

The endpoint is **LAN-only**. It must not be reachable via the public Cloudflare hostname.

The following ingress rule change is required in `cloudflared`'s `config.yml` **before COSA monitoring goes live**:

```yaml
ingress:
  - hostname: hanuman-thai-cafe.baanbaan.org
    path: /api/status
    service: http_status:403        # block external — LAN only

  - hostname: hanuman-thai-cafe.baanbaan.org
    service: http://127.0.0.1:3000

  - service: http_status:404
```

The path-block rule must appear **before** the catch-all service rule. Without this change, the status snapshot (order counts, error messages, printer IPs) is publicly accessible.

---

### 4. Schema Deviations From Spec

These differ from what the spec shows — update any COSA watcher templates accordingly:

**`hardware.terminals[].checked_at`**
- PAX D135 (counter bridge model): `checked_at` is the timestamp of the most recent poll — live.
- All other terminal models (PAX A920 Pro, PAX A800): `checked_at` is **`null`**. These terminals report a static `"configured"` status derived from the DB, not a live probe. COSA watchers on `terminals[].checked_at` must handle `null`.

**`errors.recent[].route` and `.stack`**
- Both fields are always **`null`**. They appear in the response as per the spec schema but are not yet populated. Watcher message templates that reference `{errors.recent[0].route}` will render `null`.

**`payments.terminal_errors_24h`**
- Sourced from the `payment_errors` table (Phase C), **not** from `payments.status = 'error'`. This is a more structured source — it counts rows written by `logPaymentError()` at each failure site (timeout, declined, cancelled, hardware error). This is the correct authoritative source; the spec §4.3 query example was an approximation for Phase A.

**`payments.last_successful_at`**
- Returns `MAX(created_at)` from the `payments` table without a status filter, because all payment rows represent completed transactions (there is no `status = 'error'` in the payments table). Behaviorally identical to the spec intent.

---

### 5. Null-Safety Reminders

Fields COSA watcher predicates must handle as potentially `null`:

| Field | Null when |
|-------|-----------|
| `store.next_open_label` | Store is currently open |
| `orders.oldest_active_minutes` | No active orders |
| `payments.last_successful_at` | No payments recorded yet (day 1) |
| `hardware.printers[].checked_at` | Server just started (< 5 s uptime, probe not yet run) |
| `hardware.terminals[].checked_at` | Terminal is not a PAX D135 |
| `errors.recent[].route` | Always null (not yet implemented) |
| `errors.recent[].stack` | Always null (not yet implemented) |

---

### 6. Anomaly Detection Behaviour

`security.anomalous_req_rate` works as specified:
- `true` when `req_per_min > baseline × 10`
- Baseline = **median** of last 24 hourly samples from `system_metrics`
- Returns **`false`** (never `true`) until at least 3 hourly samples have been recorded — approximately 3 hours after first deploy. This prevents false alerts on a fresh appliance.

---

### 7. Printer Probe Timing

The background probe runs **120 seconds after startup**, then every 120 seconds. In the first ~5 seconds after a server restart, all printers report `status: "unknown"` and `checked_at: null`. COSA should treat `"unknown"` as non-alerting (not the same as `"timeout"` or `"refused"`).

---

### 8. Recommended Watcher Cooldowns (from spec §5)

To avoid alert fatigue on the two most frequent triggers:
- **Printer offline:** 30-minute cooldown recommended (printer may flap on network issues)
- **Anomalous request rate:** No cooldown needed — the 10× threshold is intentionally conservative

---

### 9. What COSA Needs To Do

1. **Configure the Cloudflare tunnel** block for `/api/status` (§3 above)
2. **Provision a `cloud`-scoped API key** for each monitored merchant and store it in the COSA credential store
3. **Set poll interval** to 60 s (default per spec)
4. **Handle `null` fields** in all watcher predicates (§5 above)
5. **Treat `"unknown"` printer status as non-alerting** — alert only on `"timeout"` or `"refused"`
6. **Do not alert on `anomalous_req_rate`** until `system.uptime_s > 10800` (3 hours) or confirm baseline is established by checking `req_per_min` history