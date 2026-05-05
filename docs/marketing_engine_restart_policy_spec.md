# Spec: marketing-engine.service — flip `Restart=on-failure` → `Restart=always`

**Audience:** BaanBaan dev agent (whoever maintains the install/deploy scripts for `marketing-engine.service` on the appliance).

**Filed by:** COSA — 2026-05-05, after a production incident.

## Background

On 2026-05-05 the operator deliberately killed both `bun` processes on the
appliance to apply an update (a `pkill bun` or equivalent). The two services
behaved differently:

| Service | `Restart=` | Outcome |
|---|---|---|
| `baanbaan.service` | `always` | systemd auto-restarted in 5 s; site recovered without intervention. |
| `marketing-engine.service` | `on-failure` | bun's SIGTERM handler cleanly exited 0; systemd considered it a normal stop and **did not restart it**. The service stayed dead for ~3 hours until COSA noticed. |

`https://www.hanuman-kirkland.com/` returned `HTTP 502` from Cloudflare for the
duration (cloudflared tunnel was up; upstream `127.0.0.1:3100` had nothing
listening).

## Requested change

In the systemd unit file installed at `/etc/systemd/system/marketing-engine.service`,
change:

```ini
[Service]
...
Restart=on-failure
```

to:

```ini
[Service]
...
Restart=always
```

Keep `RestartSec=5s` as-is.

## Why `always` is the right choice for this service

`marketing-engine.service` is a stateless QR redirector with no startup-
ordering dependencies, no migrations, and no shared resources that would be
harmed by an unexpected restart. The cost of a wrongful restart is one extra
bun process spawn (~50 ms); the cost of *not* restarting on a clean exit is
that the public site goes dark until somebody notices. Same trade-off
`baanbaan.service` already makes.

## How to deploy

1. Edit `/etc/systemd/system/marketing-engine.service` (the file, not the
   repo install script — but please update the install script in
   `v2/tools/marketing-engine/` so future fresh installs ship the right
   policy).
2. `sudo systemctl daemon-reload`
3. `sudo systemctl restart marketing-engine` (optional — the new `Restart=`
   policy takes effect on the next exit either way).

## Verification

After deploy, confirm the policy is in effect:

```sh
systemctl show marketing-engine -p Restart
# should print: Restart=always
```

Optional smoke test — `kill -TERM <bun-pid-for-marketing-engine>` and confirm
that systemd brings the service back within ~5 s. `journalctl -u marketing-engine -n 20`
should show a `Scheduled restart job, restart counter is at 1` line.

## Out of scope

- COSA's `tunnel_health_check` is the safety net if this ever fails again — it
  hits the public hostname hourly and emails on `5xx`/timeout. (Note: a
  separate FK-violation bug in the alert-write path was fixed in COSA commit
  `82483d0` on the same day, restoring that safety net.)
