# Marketing-Engine Monitoring Update Spec

**Status:** Draft
**Date:** 2026-04-27
**Owner:** cosa
**Scope:** `config/appliance.yaml`, `src/cron-scheduler.js`, `tests/cron-scheduler-phase3.test.js`
**Out of scope:** All BaanBaan code, including `tools/marketing-engine/`. The 0.0.0.0-bind regression on port 3100 is documented in a separate handoff spec (`docs/baanbaan_marketing_engine_loopback_bind_spec.md`); this commit does **not** address it.

---

## 1. Context

On 2026-04-25 BaanBaan added `tools/marketing-engine/` — a Hono server that runs as `marketing-engine.service` on `*:3100` and is fronted by `cloudflared.service`, exposing `hanuman-kirkland.com`, `www.hanuman-kirkland.com`, and `qr.hanuman-kirkland.com` to the public internet. cosa monitoring did not yet know about any of this, so:

1. The 2026-04-27 weekly credential audit alerted HIGH on 4 false-positive `password_assignment` findings inside the new marketing-engine source.
2. `compliance_verify` would (or already does) flag `*:3100` as an unknown listening port.
3. Tunnel-down or misrouting would go undetected — there is no probe of `hanuman-kirkland.com`.

This spec patches all three cosa-side gaps. The 0.0.0.0-bind issue is **not** patched here because it requires a BaanBaan source change.

## 2. Verified false positives

Inspected on baanbaan@192.168.1.248 read-only on 2026-04-27:

| Fingerprint | Source | Why it's a false positive |
|---|---|---|
| `password_assignment:tools/marketing-engine/src/services/auth.ts:35` | `export async function hashPassword(password: string): Promise<string> { return Bun.password.hash(password, { algorithm: 'argon2id' }) }` | `password` is a function parameter (typed `string`), not a stored value. Argon2id hashing — correct pattern. |
| `password_assignment:tools/marketing-engine/src/services/auth.ts:39` | `export async function verifyPassword(password: string, hash: string): Promise<boolean> { return Bun.password.verify(password, hash) }` | Same — function parameter. |
| `password_assignment:tools/marketing-engine/src/routes/marketing.ts:90` | `const password = String(body.password ?? '')` then `Bun.password.verify(password, row.password_hash)` | Login handler reads password from request body and verifies against the `password_hash` column. Never persisted as plaintext. |
| `password_assignment:tools/marketing-engine/src/scripts/seed-admin.ts:10` | `const password = process.argv[3]` then hashed and `INSERT INTO admin_users(..., password_hash)` | Admin-seed CLI; password supplied at runtime via argv, hashed before storage. |

## 3. Fix — `config/appliance.yaml`

### 3.1 Credential-audit suppressions

Add three file-level entries under `tools.credential_audit.suppressed_findings`. File-level (no `line:`) handles the two-hits-in-auth.ts case and is robust to future line drift. Suppress only the specific subpath, not the whole `tools/marketing-engine/` tree — preserves coverage for any future stored secret in unrelated subdirs.

```yaml
- pattern: password_assignment
  file: tools/marketing-engine/src/services/auth.ts
  reason: "hashPassword/verifyPassword take password as a function parameter; Argon2id via Bun.password — correct hashing pattern, no stored plaintext"
- pattern: password_assignment
  file: tools/marketing-engine/src/routes/marketing.ts
  reason: "admin login route reads password from request body and verifies against password_hash column; never stored plaintext"
- pattern: password_assignment
  file: tools/marketing-engine/src/scripts/seed-admin.ts
  reason: "admin seed CLI; password supplied via process.argv[3] at runtime, hashed before INSERT into admin_users"
```

### 3.2 known_ports

`*:3100` is owned by `bun pid 67718` running `marketing-engine.service`. Add to `monitoring.known_ports` with a comment noting cloudflared is the intended ingress and that the LAN-binding is an open BaanBaan issue (separate spec).

```yaml
known_ports:
  - 22    # sshd
  - 3000  # baanbaan API (localhost only)
  - 3100  # marketing-engine.service — cloudflared ingress for hanuman-kirkland.com (currently *:3100, see docs/baanbaan_marketing_engine_loopback_bind_spec.md)
  - 20241 # cloudflared management interface (localhost only)
  - 631   # CUPS print spooler (localhost only)
```

### 3.3 New tools section: `tunnel_health_check`

```yaml
tunnel_health_check:
  enabled: true
  url: "https://hanuman-kirkland.com/"
  timeout_ms: 10000
  # HTTP statuses considered healthy (origin up, tunnel routing).
  # 5xx (especially Cloudflare 521/522/523) and network errors trigger alerts.
  expected_status_max: 499
```

## 4. Fix — `src/cron-scheduler.js`

### 4.1 `runTunnelHealthCheckTask`

Add a new task that fetches the configured URL (Node 20+ global `fetch`, with `AbortSignal.timeout` for a hard limit) and creates a `tunnel_health_check` alert iff the request fails or returns ≥ `expected_status_max + 1`.

Skeleton:

```js
async function runTunnelHealthCheckTask() {
  const { appliance } = getConfig();
  const cfg = appliance.tools?.tunnel_health_check ?? {};
  if (cfg.enabled === false) return;

  const url        = cfg.url;
  const timeoutMs  = cfg.timeout_ms ?? 10_000;
  const maxOk      = cfg.expected_status_max ?? 499;
  const operatorEmail = appliance.operator.email;

  let status; let error;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    status = res.status;
  } catch (err) {
    error = err.message;
  }
  const elapsedMs = Date.now() - t0;

  const ok = !error && status <= maxOk;
  if (ok) {
    log.info(`Tunnel health OK: ${url} → ${status} in ${elapsedMs} ms`);
    return;
  }

  // Failure path — alert + email operator.
  // ...standard createAlert + emailGateway.sendEmail...
}
```

Schedule it hourly via the existing `schedule()` helper:

```js
schedule('tunnel_health_check', '0 * * * *', runTunnelHealthCheckTask);
```

Honors `tools.tunnel_health_check.enabled === false` automatically through the AC4b guard added in v1.1.5.

### 4.2 Dedup

Same pattern as other alert paths: `findRecentAlert('tunnel_health_check', 'critical', sinceIso)` with a 30-minute dedup window so a sustained outage doesn't email the operator every hour.

## 5. Acceptance criteria

1. Running `credential_audit` against the BaanBaan repo with the new appliance.yaml produces **0** active findings for the 4 listed fingerprints (they appear in `suppressedFindings` instead).
2. `compliance_verify` no longer flags port `3100` as unknown.
3. `runTunnelHealthCheckTask`:
   - Returns silently on 200–499.
   - Creates a `tunnel_health_check` alert and emails the operator on 5xx.
   - Creates a `tunnel_health_check` alert and emails the operator on `fetch` rejection (DNS, timeout, TLS error).
4. The hourly cron is registered when `tunnel_health_check.enabled` is unset/`true` and skipped (with the existing "Cron skipped (disabled in appliance.yaml)" log line) when explicitly `false`.
5. Two new tests in `cron-scheduler-phase3.test.js` cover the 5xx and the throw paths via a mocked global `fetch`.

## 6. Non-goals (deferred)

- **Binding `marketing-engine` to `127.0.0.1` instead of `0.0.0.0`.** That's a BaanBaan source change. Spec: `docs/baanbaan_marketing_engine_loopback_bind_spec.md`.
- **Re-enabling `access_log_scan` against the new public service.** The threat model has shifted (there now is a public web frontend), but nginx still doesn't exist; logs go to `journalctl -u marketing-engine.service` and have a different shape from combined-log-format. A new spec (`docs/marketing_engine_journald_scan_spec.md`, TBD) will design a journald scanner. Not in this commit.
- **Cloudflare WAF / Logpush integration.** Out of scope for the on-appliance agent.

## 7. Rollout

Single commit on `main`:
- `config/appliance.yaml`
- `src/cron-scheduler.js` — new task + schedule call
- `tests/cron-scheduler-phase3.test.js` — two new test cases
- `docs/marketing_engine_monitoring_spec.md` (this file)
- `docs/baanbaan_marketing_engine_loopback_bind_spec.md` (handoff spec)

`package.json` / `package-lock.json` will bump to `1.1.6` and ride the next commit per the tag-first policy. After deploy, manual trigger the credential_audit to confirm the suppressions are recognised; trust the cloudflared tunnel for live verification of the new task on its first hourly tick.
