# DNS Visibility Monitor — Detecting Compromised IoT Devices on the Cafe LAN

**Status:** COSA side implemented (probe + 4 monitors, shipped disabled). Infra side (Pi-hole install, router DHCP change) is a one-time on-site task, runbook below.
**Owner:** operator
**Date:** 2026-09-14

## 1. Problem

Consumer IoT devices (digital picture frames, "super box" streaming sticks, cheap cameras/doorbells) increasingly ship with residential-proxy or botnet firmware. Once on the cafe WiFi they rent the cafe's internet connection to strangers, join DDoS attacks, and probe neighbouring hosts.

COSA's existing `network_scan` tool only sees that a *new MAC* appeared on the LAN. It cannot see what any device is doing on the internet, and a compromised device that is already on `known_mac_addresses` is invisible. The BaanBaan Pi is one host on a switched WiFi network and never sees other devices' packets.

The one vantage point every LAN device shares is the DNS resolver. A proxied device resolves thousands of unrelated hostnames per hour; a botnet node hunting for its C2 generates NXDOMAIN storms; both hit threat-intel blocklists. Owning the resolver gives COSA both **visibility** (query log) and a first layer of **blocking** (blocklists), without touching the PCI-scoped POS appliance.

## 2. Architecture

```
  IoT / staff / owner devices ──DNS──▶ Pi-hole on COSA Pi 5 (192.168.1.144:53)
                                            │ FTL query log (SQLite)
                                            ▼
                               pihole_dns_scalar probe (local sqlite3 -readonly)
                                            │ every 15 min (observation_monitors cron)
                                            ▼
                               4 data-driven monitors → operator email on medium/high
```

- **Resolver host:** the COSA Pi 5, *not* the BaanBaan POS Pi. Keeps the POS attack surface and its `ss -tlnp` port baseline unchanged (no `process-monitor` / `compliance-verify` suppression edits needed).
- **Advertised via:** the router's DHCP "DNS server" setting → every LAN client uses it automatically at next lease. The POS Pi may keep its current resolver; it is not the target of these monitors.
- **Probe:** `pihole_dns_scalar` in `src/observation-monitor.js`. Runs `sqlite3 -readonly -separator '\t' <db>` locally via `execFile` (no shell), SQL on stdin, single bare `SELECT` enforced by the same validator as `sqlite_scalar`. First column = numeric value, optional second column = label (the offending client IP) so the alert can name the device.
- **Config:** `dns_monitor.pihole_db_path` in `config/appliance.yaml` (default `/etc/pihole/pihole-FTL.db`).
- **Monitors:** `config/observation-monitors.js`, ids below. All `enabled: false` until step 5.

## 3. Monitors

| id | Window | Value | medium | high | What it catches |
|---|---|---|---|---|---|
| `dns_client_query_flood` | 15 min | max queries by one client | 1500 | 5000 | Proxy exit node / DDoS participant |
| `dns_client_domain_spread` | 15 min | max distinct domains by one client | 300 | 1000 | Strangers' browsing routed through one device |
| `dns_client_nxdomain_burst` | 15 min | max NXDOMAIN replies to one client | 100 | 500 | DGA malware hunting for C2 |
| `dns_blocked_spike` | 60 min | max blocklist hits by one client | 20 | 200 | Device reaching known-bad infrastructure |

All per-client stats exclude `127.0.0.1` / `::1` (the Pi 5's own lookups). Thresholds are first-guess baselines — **validate against a week of real traffic before enabling** (step 5).

Pi-hole FTL `queries` view columns used: `timestamp` (unix seconds), `client` (IP), `domain`, `status` (blocked = 1, 4–11, 16), `reply_type` (2 = NXDOMAIN).

## 4. Install runbook (on-site, COSA Pi 5)

Requires being on the cafe WiFi (`ssh cosa`). ~30 min.

### 4.1 Check port conflicts first

```bash
sudo ss -tulnp | grep -E ':(53|80|443) '
```

Pi-hole needs UDP/TCP 53. Its web UI defaults to 80/443 — if anything on the Pi 5 already binds those, set the web port afterwards in `/etc/pihole/pihole.toml` (`webserver.port = "8053"`) and `sudo systemctl restart pihole-FTL`.

### 4.2 Install Pi-hole

```bash
curl -sSL https://install.pi-hole.net | sudo bash
# Interface: the LAN interface (eth0/wlan0)
# Upstream: Quad9 9.9.9.9 (blocks malware domains upstream too) or Cloudflare 1.1.1.1
# Decline the default ad blocklist (StevenBlack) — see 4.3 — or remove it after.
sudo apt-get install -y sqlite3          # CLI the probe shells out to
sudo usermod -aG pihole cosa             # read access to /etc/pihole/pihole-FTL.db
sudo systemctl restart cosa              # pick up the new group
sudo -u cosa sqlite3 -readonly /etc/pihole/pihole-FTL.db "SELECT COUNT(*) FROM queries"   # must not error
```

### 4.3 Blocklists — threat-intel only

`dns_blocked_spike` assumes a hit means "known-bad infrastructure", not "banner ad". Use threat lists only, no ad lists, so staff phones don't trip it:

- `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt` — Hagezi Threat Intelligence Feeds
- `https://urlhaus.abuse.ch/downloads/hostfile/` — abuse.ch URLhaus malware hosts
- `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/doh-vpn-proxy-bypass.txt` — DoH/VPN/proxy bypass endpoints; makes DNS-over-HTTPS evasion attempts visible as blocked lookups

Add via *Lists* in the web UI, then `pihole -g`. Remove StevenBlack if the installer added it.

### 4.4 Router DHCP

At the cafe gateway (192.168.1.1): LAN → DHCP → **Primary DNS = 192.168.1.144**, secondary blank (a secondary public DNS lets clients bypass Pi-hole silently). Clients pick it up at next lease renewal; power-cycle the printers/tablets or wait ~24 h.

Do **not** change the POS Pi's resolver as part of this task (BaanBaan policy: no changes to that box without a spec).

### 4.5 Confirm traffic is arriving

```bash
sudo -u cosa sqlite3 -readonly -separator '|' /etc/pihole/pihole-FTL.db \
  "SELECT COUNT(*), client FROM queries WHERE timestamp >= strftime('%s','now')-900 GROUP BY client ORDER BY 1 DESC"
```

Expect one row per LAN device within a few minutes of the DHCP change.

## 5. Baseline + enable

After **7 days** of traffic, run each monitor's SQL by hand at a few times of day (lunch rush, closed) and note the max seen:

```bash
cd /home/cosa/cosa && node -e "
const m=require('./config/observation-monitors').filter(d=>d.id.startsWith('dns_'));
const {PROBES}=require('./src/observation-monitor');
(async()=>{for(const d of m){const r=await PROBES.pihole_dns_scalar(d.params);console.log(d.id,r.value,r.context.label,'->',d.threshold)}})()"
```

If the observed healthy max is within 2× of `medium`, raise the threshold; the goal is zero alerts in a normal week. Then flip `enabled: true` on the four `dns_*` entries in `config/observation-monitors.js`, commit, `git pull && systemctl restart cosa`. Alerts dedupe per monitor for 3 h (`OBSERVATION_DEDUP_WINDOW_MS`).

## 6. Responding to an alert

1. The email names the client IP. Find it in the router client list → MAC → `known_mac_addresses` name in `appliance.yaml`.
2. Cross-check in the Pi-hole query log (*Query Log*, filter by client) — what domains? Gambling/mail/crypto/random TLDs from a picture frame is the signature.
3. **Contain:** unplug the device, or block its MAC at the router. Pi-hole can also drop it: *Clients* → add IP → assign to a group with a `.*` regex deny rule scoped to that group. This stops DNS-based traffic only.
4. Annotate the MAC entry in `appliance.yaml` (`# QUARANTINED 2026-xx-xx, dns_client_query_flood`).

## 7. Limitations

- Firmware that uses hard-coded IPs or its own DoH/DoT client bypasses the resolver entirely. The `doh-vpn-proxy-bypass` list surfaces *attempts* to reach known DoH endpoints as blocked lookups, but a device with a baked-in relay IP is invisible here. Egress accounting at the router (option #2 in the original assessment) is the next layer.
- Guest WiFi is a separate network and is not covered unless the router hands it the same DNS.
- Pi-hole flushes queries to the DB every 60 s; the 15-minute windows are unaffected.
- This is detection plus DNS-level blocking. COSA still has no tool to block a device at the router; that would be a new `high`-risk approval-gated tool once the gateway exposes an API.

## 8. Rollback

Router DHCP DNS back to ISP/auto → clients stop using Pi-hole at next lease. `sudo pihole uninstall` on the Pi 5. Monitors are inert while `enabled: false`; with the `dns_monitor` config block removed the probe throws `dns_monitor.pihole_db_path is not configured` rather than doing anything.
