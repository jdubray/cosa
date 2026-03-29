# COSA — Code-Operate-Secure Agent

COSA is a persistent, autonomous operations agent for software appliances. It watches your system around the clock, alerts you when something is wrong, answers questions by email, and asks for permission before changing anything. No dashboard. No app. Just your inbox.

The first supported appliance is **Baanbaan**, a POS relay for small restaurants running on ARM hardware (Raspberry Pi 4) with a Bun/SQLite/SAM stack.

**For restaurant owners:** See the [User Manual](USER_MANUAL.md) — no technical knowledge required.

---

## How It Works

COSA runs headless on a dedicated Raspberry Pi on the same LAN as the appliance it manages. The operator communicates with COSA by sending plain-text email. COSA responds with results, alerts, and approval requests.

```
Local Network
┌──────────────────────────────────────────────┐
│                                              │
│   ┌─────────────┐         ┌─────────────┐    │
│   │  COSA Pi    │──SSH──▶│ Baanbaan Pi │    │
│   │  (agent +   │         │  (POS app + │    │
│   │  datastores)│         │  SQLite)    │    │
│   └─────────────┘         └─────────────┘    │
│          │                                   │
│          └── Email (SMTP/IMAP) ──▶ Internet  │
│                                              │
└──────────────────────────────────────────────┘
```

COSA has no inbound ports. It makes outbound connections only: SSH to the appliance (LAN), IMAP/SMTP to the email provider, and HTTPS to the Claude API. The appliance is never directly exposed to COSA's internet connection.

---

## Phase 1 Features (Implemented)

**Health Monitoring**
- Hourly health checks via HTTP (`/health`, `/health/ready`) and systemd process state over SSH
- Status classification: `healthy`, `degraded`, or `unreachable`
- Alert emails sent to the operator on degradation or failure
- Alert deduplication — no repeat emails within 60 minutes for the same condition

**Operator Queries**
- The operator sends plain-text email asking about appliance state
- COSA runs the appropriate tool, interprets the result, and replies within 2 minutes
- In `simple` mode (default): plain business language, no jargon
- In `advanced` mode: full technical detail including status codes, metrics, and raw output

**Read-Only Database Access**
- COSA can run `SELECT` queries against the Baanbaan SQLite database over SSH
- All queries validated: no `DROP`, `DELETE`, `UPDATE`, `INSERT`, `CREATE`, `ALTER`
- SQL is passed via stdin to prevent shell injection
- Results capped at 100 rows

**Database Integrity Checks**
- `PRAGMA integrity_check` to detect corruption
- `PRAGMA wal_checkpoint` to manage WAL file growth

**Operator Approval Flow**
- Any non-read action requires explicit operator approval via email
- COSA sends an approval request with a one-time token (`APPROVE-XXXXXXXX`)
- Operator replies with the token to approve, or `DENY [reason]` to reject
- Approvals expire after 30 minutes (5 minutes for urgent requests)
- All decisions — approvals, denials, and expirations — are logged permanently

**Security Gate**
- Every tool call is checked against configurable dangerous-command patterns before execution
- Blocked patterns: `rm -rf`, `DROP TABLE`, `DROP DATABASE`, unscoped `DELETE`, `kill -9`, `systemctl stop/disable`, raw disk operations, `chmod 777`, pipe-to-shell, credential exposure
- Tool output is sanitized to strip API keys and credentials before they reach the LLM

**SSH Host Key Verification**
- COSA verifies the appliance SSH host key fingerprint on every connection
- Mismatches are refused and logged as potential MITM attacks
- Configure `host_key_fingerprint` in `appliance.yaml` (strongly recommended)

**Full Audit Trail**
- Every session, turn, tool call, approval, and alert is persisted to `data/session.db`
- Full-text search across all conversation history via SQLite FTS5

---

## Requirements

- **Node.js** >= 20.0.0
- **COSA Pi:** Raspberry Pi (or any Linux machine) on the same LAN as the appliance
- **Appliance Pi:** Must expose `/health` and `/health/ready` HTTP endpoints, managed by systemd as service `baanbaan`
- **Email account:** Dedicated Gmail account with IMAP enabled and an App Password configured
- **Anthropic API key:** Claude Sonnet 4.6 is used for all agent sessions

---

## Setup

### The fast way (recommended)

After installing dependencies, run the interactive setup wizard:

```bash
npm install
npm run setup
```

The wizard walks you through connecting to Baanbaan, configuring email, and verifying everything works — no manual file editing required. It takes about 5 minutes.

**What you'll need before starting:**
- Your Baanbaan device powered on and connected to your network
- The 6-digit setup PIN from the Baanbaan device screen (or setup email)
- A dedicated Gmail account for COSA, with IMAP enabled and an App Password generated (see [Gmail setup](#gmail-setup-step-by-step) below)
- An Anthropic API key from `console.anthropic.com`

After the wizard completes, skip to [Start COSA](#5-start-cosa).

---

### The manual way

If you prefer to configure by hand, follow the steps below.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the appliance adapter

Edit `config/appliance.yaml` with your appliance's connection details:

```yaml
ssh:
  host: "192.168.1.10"          # Baanbaan Pi LAN IP
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_ed25519_baanbaan"
  host_key_fingerprint: "SHA256:..."  # Strongly recommended — see below

appliance_api:
  base_url: "http://192.168.1.10:3000"

operator:
  email: "owner@restaurant.com"
  name: "Restaurant Manager"
```

**To obtain the SSH host key fingerprint:**
```bash
ssh-keyscan -t ed25519 192.168.1.10 | ssh-keygen -l -E sha256 -f -
# Copy the SHA256:... portion (including the "SHA256:" prefix)
```

### 3. Configure credentials

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=sk-ant-...
COSA_EMAIL_ADDRESS=cosa.baanbaan@gmail.com
COSA_EMAIL_IMAP_HOST=imap.gmail.com
COSA_EMAIL_IMAP_PORT=993
COSA_EMAIL_SMTP_HOST=smtp.gmail.com
COSA_EMAIL_SMTP_PORT=587
COSA_EMAIL_USERNAME=cosa.baanbaan@gmail.com
COSA_EMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

#### Gmail setup (step by step)

COSA uses a Gmail App Password — a 16-character code that lets COSA connect to Gmail without knowing your Google account password. You generate it once and paste it into `.env`.

**Step 1 — Enable IMAP in Gmail**

IMAP is how COSA reads incoming email. It's off by default in new Gmail accounts.

1. Open Gmail and click the gear icon (top right) → **See all settings**
2. Click the **Forwarding and POP/IMAP** tab
3. Under "IMAP access", select **Enable IMAP**
4. Click **Save Changes**

**Step 2 — Enable 2-Step Verification on the Google account**

App Passwords require 2-Step Verification to be on first. If you already have it enabled, skip to Step 3.

1. Go to your Google Account: click your profile picture (top right in Gmail) → **Manage your Google Account**
2. Click the **Security** tab
3. Under "How you sign in to Google", click **2-Step Verification**
4. Follow the prompts to turn it on (usually takes 2–3 minutes)

**Step 3 — Generate an App Password**

1. Go back to your Google Account → **Security** tab
2. Under "How you sign in to Google", click **2-Step Verification**
3. Scroll to the bottom and click **App passwords**
   - If you don't see "App passwords", make sure 2-Step Verification is fully enabled
4. In the "App name" box, type something like `COSA` so you remember what it's for
5. Click **Create**
6. Google will show a 16-character password like `abcd efgh ijkl mnop`
7. Copy it — **this is the only time Google shows it**
8. Paste it into `.env` as `COSA_EMAIL_APP_PASSWORD`, removing the spaces:
   ```
   COSA_EMAIL_APP_PASSWORD=abcdefghijklmnop
   ```

> If you lose the App Password, just go back to App passwords and create a new one. Delete the old one from the list to keep things tidy.

### 4. Configure the appliance context

Edit `config/APPLIANCE.md` to match your deployment — LAN IPs, operator contact, deploy paths. This file is included verbatim in every agent session.

### 5. Start COSA

```bash
npm start
```


On first run, `data/session.db` is created automatically with the full schema.

---

## Running Tests

```bash
# Unit and integration tests
npm test

# End-to-end staging tests (run sequentially, require mocks only)
npm run test:staging
```

---

## Project Structure

```
cosa/
├── src/
│   ├── main.js                  # Entry point — boot sequence
│   ├── orchestrator.js          # Core agent loop (Claude API + tool dispatch)
│   ├── context-builder.js       # System prompt assembly
│   ├── session-store.js         # SQLite persistence layer
│   ├── tool-registry.js         # Tool registration and dispatch
│   ├── security-gate.js         # Pre-execution security filter + output sanitizer
│   ├── approval-engine.js       # Operator approval FSM and token lifecycle
│   ├── ssh-backend.js           # SSH connection pool to appliance
│   ├── logger.js                # Structured JSON logging
│   ├── interfaces/
│   │   ├── email-gateway.js     # IMAP polling + SMTP sending
│   │   └── cron-scheduler.js    # Scheduled health check tasks
│   └── tools/
│       ├── health-check.js      # health_check tool
│       ├── db-query.js          # db_query tool
│       └── db-integrity.js      # db_integrity tool
├── config/
│   ├── appliance.yaml           # Appliance adapter configuration
│   ├── cosa.config.js           # Config loader (env + yaml)
│   └── APPLIANCE.md             # Agent-readable appliance identity
├── data/
│   └── session.db               # SQLite database (auto-created)
├── tests/
│   ├── *.test.js                # Unit tests
│   ├── tools/                   # Tool unit tests
│   └── staging/                 # End-to-end scenario tests
└── docs/
    ├── cosa_phase1_spec.md      # Phase 1 technical specification
    ├── cosa_functional_spec.md  # Functional requirements
    └── cosa-architecture-proposal.md
```

---

## Architecture

COSA is built around a single agent loop: receive trigger → build system prompt → call Claude → process tool calls → return response. Complexity lives in the tools and security layers, not in the loop.

**Three security layers on every tool call:**
1. **Security gate** — blocks dangerous command patterns before execution
2. **Approval gate** — routes medium/high/critical risk calls to operator via email
3. **Output sanitizer** — strips credentials from tool output before LLM sees it

**Data model:**
- `sessions` — one row per agent invocation
- `turns` — full conversation history per session
- `tool_calls` — every tool dispatch (including blocked and denied)
- `approvals` — approval request lifecycle
- `alerts` — outbound alert emails with deduplication metadata

**SSH security:** The LLM cannot construct SSH commands. Tools call `sshBackend.exec()` with static command strings. SQL queries are passed via stdin, not as shell arguments, preventing injection through any user-controlled content.

---

## Operator Modes

COSA supports two communication modes, configured via `COSA_OPERATOR_MODE` in `.env`:

| Mode | Audience | Email style |
|------|----------|-------------|
| `simple` (default) | Restaurant owners and managers | Plain business language. No technical jargon. Focuses on business impact ("your system is offline") rather than technical cause ("SSH timeout after 5s"). |
| `advanced` | Technically savvy operators or developers | Full technical detail — HTTP status codes, systemd states, SSH connectivity, database metrics, raw tool output. Useful when troubleshooting with a developer. |

Switch modes at any time by editing `.env` and restarting COSA. The mode only affects what COSA writes in outbound emails; behavior, security, and logging are identical in both modes.

---

## Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1 — Foundation | Health checks, email interface, approval system | Complete |
| 2 — Operate | Backup, shift reports, memory system, skill library | Planned |
| 3 — Secure | Intrusion detection, Cloudflare kill, PCI compliance | Planned |
| 4 — Code | Bug fixes, deployments, dependency audits | Planned |
| 5 — Evolve | AI-native memory, skill self-improvement | Planned |

---

## License

UNLICENSED — proprietary.
