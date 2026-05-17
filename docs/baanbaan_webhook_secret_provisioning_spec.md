# Spec — Provision webhook HMAC secret for the production merchant

| | |
|---|---|
| **Date** | 2026-05-16 |
| **Status** | Draft, awaiting BaanBaan-side implementation |
| **Owner (spec)** | cosa monitoring |
| **Owner (impl)** | BaanBaan |
| **Estimated effort** | 5 minutes (one API call + a config update on the integrator side) |

## Goal

Configure the `webhook_secret_enc` column on the production merchant row in `merchant.db` so that the generic webhook endpoint actively exercises the HMAC compare path on every incoming request.

## Background

The BaanBaan generic webhook route at `POST /webhooks/generic/:merchantId` (defined in `src/routes/webhooks.ts`) has two layered guards:

1. **"No secret configured" guard** (lines 55-61): returns `401 — Webhook secret not configured — unsigned webhooks are rejected` if `merchants.webhook_secret_enc IS NULL`.
2. **HMAC compare guard** (lines 79-93): decrypts the stored secret, recomputes `sha256(timestamp + "." + body)` (or `sha256(body)` if no `X-Webhook-Timestamp` header), and `timingSafeEqual`s against `X-Webhook-Signature`. Returns `401 — Invalid signature` on mismatch.

Today, every merchant in `merchant.db` has `webhook_secret_enc IS NULL`. The only configured merchant is `m_69c917c12c234519`. Every incoming webhook request — legitimate or forged — is bounced at guard #1 before guard #2 ever runs.

Result: the HMAC compare code is present and unit-tested, but **not currently exercised in production**. COSA's `webhook_hmac_verify` probe correctly returns `verified: true` because guard #1 returns 401, but the verdict tells us nothing about whether the compare path actually works in the deployed binary.

## Implementation

Run **on the appliance**, with a JWT obtained for an owner-role user:

```bash
# 1) Log in as an owner to get a JWT (replace EMAIL/PASSWORD with a real owner account)
TOKEN=$(curl -sS -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"EMAIL","password":"PASSWORD"}' \
  | jq -r '.accessToken')

# 2) Generate and persist a new 32-byte webhook secret for the production merchant
curl -sS -X POST http://127.0.0.1:3000/api/merchants/m_69c917c12c234519/webhook/secret \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.secret'   # <-- copy this value; it is returned ONCE
```

The handler at `src/routes/merchants.ts:1007-1020`:
- Generates 32 random bytes, hex-encodes (64 chars).
- Calls `encryptWebhookSecret(merchantId, secret)` → AES-256-GCM under the appliance key.
- `UPDATE merchants SET webhook_secret_enc = ? WHERE id = ?`.
- Returns the plaintext secret exactly once. **It cannot be retrieved later.**

### Distributing the secret to the webhook caller

Whatever external system POSTs to `/webhooks/generic/m_69c917c12c234519` must be updated to:

1. Store the new 64-char hex secret in its own configuration.
2. For each outgoing request:
   - Set `X-Webhook-Timestamp` to the current ISO-8601 timestamp (within 5 minutes of send — see replay guard at `webhooks.ts:64-69`).
   - Compute `signature = hmac_sha256(secret, timestamp + "." + raw_body)`.
   - Set `X-Webhook-Signature: sha256=<hex_signature>`.

If there is **no external system currently posting** to this endpoint, skip the distribution step — the secret can sit unused, and COSA's probe will still exercise the compare path.

### Verifying success

After provisioning, run on the appliance:

```bash
curl -sS http://127.0.0.1:3000/api/merchants/m_69c917c12c234519/webhook/secret/status \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"configured":true}
```

And confirm the probe still passes via COSA — note the response message changes:

```bash
# From cosa:
ssh cosa 'cd /home/cosa/cosa && node -e "
  const ssh = require(\"./src/ssh-backend\");
  const tool = require(\"./src/tools/webhook-hmac-verify\");
  (async () => {
    await ssh.init();
    await new Promise(r => setTimeout(r, 1500));
    console.log(JSON.stringify(await tool.handler(), null, 2));
    await ssh.disconnect();
  })().catch(e => { console.error(e); process.exit(1); });
"'
```

The probe will still return `verified: true, status_code: 401`, but now the 401 originates from the HMAC compare path (`Invalid signature`) instead of the "no secret configured" guard. To distinguish in logs, the appliance writes a `security_log` event of type `webhook_invalid_signature` (vs `webhook_unsigned`) — `tail /var/log/...` or check the `security_log` table for the differentiation.

## Acceptance criteria

1. `GET /api/merchants/m_69c917c12c234519/webhook/secret/status` returns `{"configured":true}`.
2. A `POST /webhooks/generic/m_69c917c12c234519` with no signature returns 401 `Invalid signature` (not `Webhook secret not configured`). Confirms the compare path is reached.
3. COSA's next scheduled `webhook_hmac_verify` cron run (Monday 02:00) emits no critical alert and writes a `verified: true` entry to `session.db`.
4. Existing webhook callers (if any) are updated and continue to receive 2xx responses for properly-signed requests.

## Rollback

If anything is wrong, revoke the secret:

```bash
curl -sS -X DELETE http://127.0.0.1:3000/api/merchants/m_69c917c12c234519/webhook/secret \
  -H "Authorization: Bearer $TOKEN"
# Returns {"ok":true}; webhook_secret_enc is set back to NULL.
```

The endpoint then reverts to the "no secret configured" guard — same behavior as today.

## Out of scope (for this spec)

- Rotating the secret. (Future spec: time-based rotation, dual-secret overlap window.)
- Adding webhook callers. This spec only enables the security path; it does not introduce new traffic.
- Changing the appliance binding from loopback-only. The probe-via-SSH design accommodates the loopback-only posture deliberately.

## References

- BaanBaan source: `src/routes/webhooks.ts` (HMAC validation), `src/routes/merchants.ts:980-1040` (secret management endpoints).
- COSA probe: `src/tools/webhook-hmac-verify.js` (post-2026-05-16 rewrite).
- Original cron/alert plumbing: `src/cron-scheduler.js`, category `webhook_hmac_verify`.
