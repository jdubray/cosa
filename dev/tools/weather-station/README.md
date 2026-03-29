# COSA Weather Station Mock

A local development appliance that lets you run and test COSA without a real Baanbaan Pi. It implements the full COSA Phase 1 protocol — health API, setup API, SSH interface, and SQLite database — using real weather data fetched hourly from [Open-Meteo](https://open-meteo.com/) (free, no API key).

From COSA's perspective it looks and behaves like a Baanbaan POS device: it responds to the same health checks, database queries, and systemd status commands. The difference is that instead of POS order data, the database holds live weather readings.

---

## Prerequisites

- **Node.js** >= 20
- **ssh-keygen** — for generating the SSH host key on first start (included with OpenSSH on macOS, Linux, and Windows 10+)
- An internet connection (for weather API calls)

---

## Start the weather station

```bash
cd dev/tools/weather-station
npm install
npm start
```

On first run, the station will:

1. Generate an SSH host key (`data/host_key`)
2. Generate a 6-digit setup PIN
3. Fetch the first weather reading from Open-Meteo
4. Print the PIN and the COSA `appliance.yaml` config snippet

You will see output like:

```
┌──────────────────────────────────────────────────────────────┐
│  COSA Setup PIN: 847291                                       │
│  Expires: 2026-03-30T14:00 UTC                               │
│                                                               │
│  Run the COSA setup wizard to connect:                        │
│    cd <cosa-directory>                                        │
│    npm run setup                                              │
│                                                               │
│  When asked for Baanbaan IP, enter: 127.0.0.1                 │
│  When asked for the setup PIN, enter the code above.          │
└──────────────────────────────────────────────────────────────┘
```

---

## Connect COSA (two options)

### Option A — Setup wizard (recommended)

1. Keep the weather station running
2. In the COSA directory: `npm run setup`
3. When the wizard asks for the Baanbaan IP, enter `127.0.0.1`
4. Enter the PIN shown at weather station startup
5. Complete the wizard normally

**Important:** After the wizard finishes, open `config/appliance.yaml` and change:
```yaml
ssh:
  port: 22        # ← change this to 2222
```
The setup wizard always writes port 22 (the Baanbaan default). The weather station SSH mock runs on port 2222 to avoid needing root.

### Option B — Manual config

Copy the `appliance.yaml` snippet printed at startup into your COSA `config/appliance.yaml`. The snippet already has the correct port (2222) and host key fingerprint.

You still need to fill in the `operator`, `cron`, `security`, and `tools` sections — copy those from `config/appliance.yaml.example` in the COSA directory.

---

## What it simulates

| COSA tool | What the mock does |
|---|---|
| `health_check` — SSH check | SSH server accepts the registered COSA key |
| `health_check` — HTTP /health | Returns `{"status":"ok","uptime_seconds":N}` |
| `health_check` — HTTP /health/ready | Returns `{"ready":true}` |
| `health_check` — systemd | Returns `ActiveState=active`, `SubState=running`, 0 restarts |
| `db_query` — SELECT query | Executes real SELECT against `data/weather.db` via better-sqlite3 |
| `db_integrity` — integrity_check | Runs real `PRAGMA integrity_check` |
| `db_integrity` — wal_checkpoint | Runs real `PRAGMA wal_checkpoint(PASSIVE)` |

The SSH server **does not** execute arbitrary shell commands — only the specific command patterns the COSA tools send. Everything else returns exit code 127.

---

## Database schema

```sql
-- One row per hourly weather fetch
CREATE TABLE readings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at         TEXT    NOT NULL,          -- ISO 8601 UTC timestamp
  temperature_c       REAL,                      -- degrees Celsius
  humidity_pct        REAL,                      -- percent (0–100)
  pressure_hpa        REAL,                      -- hPa / mbar
  wind_speed_kmh      REAL,                      -- km/h
  wind_direction_deg  INTEGER,                   -- 0–360°
  weather_code        INTEGER,                   -- WMO weather code
  weather_description TEXT                       -- human-readable
);

-- Metadata (station start time, etc.)
CREATE TABLE station_info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Sample queries you can ask COSA

```
How many weather readings do we have?
```
```
What was the temperature at noon yesterday?
```
```
Show me the last 10 readings.
```
```
What's the average humidity this week?
```

---

## Configuration

Edit `config/station.yaml` to change the location, HTTP port, or SSH port:

```yaml
weather:
  latitude: 40.7128
  longitude: -74.0060
  location_name: "New York, NY"
  fetch_cron: "5 * * * *"   # every hour at :05

http:
  port: 3000

ssh:
  port: 2222
  user: "weather"
```

---

## Reset (start fresh)

To clear all state — registered keys, PIN, database, host key — and start over:

```bash
npm run reset
npm start
```

This deletes the `data/` directory. COSA will lose its SSH access and you will need to re-run `npm run setup` (or re-register manually) with the new PIN.

---

## Ports

| Service | Default port | Notes |
|---|---|---|
| HTTP (health + setup) | 3000 | Change in `config/station.yaml` |
| SSH mock | 2222 | Change in `config/station.yaml`; update `ssh.port` in COSA's `appliance.yaml` |

---

## Files in data/

| File | Contents |
|---|---|
| `data/host_key` | SSH host private key (ED25519) |
| `data/host_key.pub` | SSH host public key |
| `data/setup_pin.json` | Current setup PIN, expiry, used flag |
| `data/authorized_keys` | COSA's registered SSH public key |
| `data/cosa_registered` | Flag file — present once COSA has registered |
| `data/weather.db` | SQLite database with weather readings |

All files in `data/` are excluded from git via `.gitignore`.
