# BaanBaan Handoff Spec — bind marketing-engine to 127.0.0.1

**Status:** Draft — for handoff to the BaanBaan repo maintainer
**Date:** 2026-04-27
**Owner:** cosa (spec author); BaanBaan maintainer (implementer)
**Repo:** `/home/baanbaan/baan-baan-merchant/v2` on the appliance, `tools/marketing-engine/` subtree
**This is *not* a cosa change.** Per cosa's BaanBaan modification policy, no Claude session in the cosa repo will touch BaanBaan source. This spec exists to be picked up by whoever does modify BaanBaan.

---

## 1. Problem

`marketing-engine.service` listens on `*:3100` (all interfaces, including the cafe LAN). cloudflared tunnels public traffic to `http://127.0.0.1:3100`, so loopback binding is sufficient for the intended ingress path. The current `0.0.0.0` bind means anyone on the cafe WiFi can hit the admin login form directly, bypassing Cloudflare's edge controls (WAF, rate-limiting, bot fight, JS challenge, etc.).

Verified on the appliance 2026-04-27:

```
$ ss -tlnp | grep 3100
LISTEN  0  512  *:3100  *:*  users:(("bun",pid=67718,fd=15))

$ sudo cat /etc/cloudflared/config.yml
ingress:
  - hostname: hanuman-kirkland.com
    service: http://127.0.0.1:3100   ← cloudflared only ever needs loopback
  - hostname: www.hanuman-kirkland.com
    service: http://127.0.0.1:3100
  - hostname: qr.hanuman-kirkland.com
    service: http://127.0.0.1:3100
```

The systemd unit pins `Environment=PORT=3100` but nothing about the host:

```
[Service]
ExecStart=/home/baanbaan/.bun/bin/bun run src/server.ts
Environment=PORT=3100
```

So the host comes from the application code in `src/server.ts`.

## 2. Threat model

Direct LAN access to `http://192.168.1.248:3100/` exposes:

- The admin login route (`POST /admin/login`) to brute-force from any device on the cafe WiFi (employee/guest WiFi separation depends on router config).
- The `/redirect/:slug` and `/api/scan` endpoints to scan-flooding that pollutes campaign analytics.
- Any internal-only routes the team adds in the future.

Cloudflare's protections (WAF, rate-limit, bot-management, JS challenge) only apply to traffic that arrives through the tunnel. LAN traffic skips all of it.

## 3. Fix

In `tools/marketing-engine/src/server.ts`, pass `hostname: '127.0.0.1'` to the Hono `serve()` call (or whatever bind helper is used), reading from an env var so it remains tunable:

```ts
import { serve } from '@hono/node-server'   // or Bun.serve, depending on existing entry shape

const port = Number(process.env.PORT ?? 3100)
const hostname = process.env.HOST ?? '127.0.0.1'   // loopback by default

serve({ fetch: app.fetch, port, hostname })
```

Equivalent for `Bun.serve({ port, hostname })` if that's the pattern in use today.

In the systemd unit `/etc/systemd/system/marketing-engine.service`, optionally pin:

```
Environment=HOST=127.0.0.1
```

`Environment=PORT=3100` stays as-is.

## 4. Acceptance criteria

1. After restart of `marketing-engine.service`, `ss -tlnp | grep 3100` shows `127.0.0.1:3100` (or `[::1]:3100`), **not** `*:3100` or `0.0.0.0:3100`.
2. `curl http://192.168.1.248:3100/` from another LAN host **fails** with connection refused.
3. `curl https://hanuman-kirkland.com/` continues to work end-to-end (cloudflared → loopback unaffected).
4. `curl http://127.0.0.1:3100/` from inside the appliance still works (for ad-hoc operator debugging).

## 5. Cosa-side follow-up

Once deployed and acceptance criteria 1–4 are confirmed:

- Update `config/appliance.yaml`'s `monitoring.known_ports` comment for port 3100 to drop the "currently *:3100" caveat.
- Compliance-verify will continue to recognise 3100 as a known port; no further cosa change required.

## 6. Non-goals

- Adding a separate guest-WiFi VLAN or router-level firewall rules. (Defense-in-depth, but a different layer.)
- Migrating off cloudflared to nginx + Let's Encrypt. (Would require an entirely different monitoring config.)
- Rate-limiting the marketing-engine login route in application code. (Useful, but cloudflared+CF rules already provide this for the legitimate ingress path; the bind fix removes the bypass.)
