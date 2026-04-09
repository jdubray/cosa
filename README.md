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
│   │  (agent +   │──HTTP─▶│  (POS app + │    │
│   │  datastores)│         │  SQLite)    │    │
│   └─────────────┘         └─────────────┘    │
│          │                                   │
│          └── Email (SMTP/IMAP) ──▶ Internet  │
│                                              │
└──────────────────────────────────────────────┘
```

COSA has no inbound ports. It makes outbound connections only: SSH to the appliance (LAN), HTTP to the appliance REST API (LAN), IMAP/SMTP to the email provider, and HTTPS to the Claude API. The appliance is never directly exposed to COSA's internet connection.

---

## Features

### Health Monitoring
- Hourly health checks via HTTP (`/health`, `/health/ready`) and systemd process state over SSH
- Status classification: `healthy`, `degraded`, or `unreachable`
- Alert emails sent to the operator on degradation or failure
- Alert deduplication — no repeat emails within 60 minutes for the same condition

### Operator Queries
- The operator sends plain-text email asking about appliance state
- COSA runs the appropriate tool, interprets the result, and replies within 2 minutes
- In `simple` mode (default): plain business language, no jargon
- In `advanced` mode: full technical detail including status codes, metrics, and raw output

### Read-Only Database Access
- COSA can run `SELECT` queries against the appliance SQLite database over SSH
- All queries validated: no `DROP`, `DELETE`, `UPDATE`, `INSERT`, `CREATE`, `ALTER`
- SQL is passed via stdin to prevent shell injection
- Results capped at 100 rows

### Automated Monitoring — Watchers
- Operators describe conditions in plain language by email; Claude generates monitoring predicates automatically
- Watchers are small JavaScript functions stored in the database and run on every status poll
- Each watcher receives the live status snapshot and returns `{ triggered: boolean, message? }`
- Triggered alerts fire by email; a per-watcher cooldown (default 30 minutes) suppresses repeats
- Watchers run inside a two-layer sandbox: child process boundary + `vm.createContext` (no `require`, no `process`, no network access)
- Manage watchers by email: register, list, pause, resume, delete

### Appliance API Integration
- COSA can make authenticated write calls to a pre-approved endpoint allowlist configured in `appliance.yaml`
- Endpoints are explicitly named and risk-rated (`medium` or `high`) by the operator
- Claude resolves which endpoint to call by name; arbitrary endpoints are blocked
- Path parameters can be static (from credential store) or dynamic (supplied by caller); callers cannot override static params
- Request bodies are validated against a JSON schema before dispatch
- Medium-risk calls triggered by email are auto-approved; all other medium and high-risk calls require explicit operator approval

### Operator Approval Flow
- Any non-read action requires explicit operator approval via email
- COSA sends an approval request with a one-time token (`APPROVE-XXXXXXXX`)
- Operator replies with the token to approve, or `DENY [reason]` to reject
- Approvals expire after 30 minutes (5 minutes for urgent requests)
- All decisions — approvals, denials, and expirations — are logged permanently

### Security Gate
- Every tool call is checked against configurable dangerous-command patterns before execution
- Blocked patterns: `rm -rf`, `DROP TABLE`, `DROP DATABASE`, unscoped `DELETE`, `kill -9`, `systemctl stop/disable`, raw disk operations, `chmod 777`, pipe-to-shell, credential exposure
- Optional Tirith pre-execution scanner integration (binary at `~/.cosa/bin/tirith`)
- Tool output is sanitized to strip API keys and credentials before they reach the LLM

### SSH Host Key Verification
- COSA verifies the appliance SSH host key fingerprint on every connection
- Mismatches are refused and logged as potential MITM attacks
- Configure `host_key_fingerprint` in `appliance.yaml` (strongly recommended)

### Additional Security Tools
- Network scan with known MAC address verification
- Cloudflare kill-switch for emergency network isolation
- PCI compliance assessment (filesystem, process, and network checks)
- IPS alert scanning
- Credential audit (scans repository for hardcoded secrets)
- Token rotation reminders
- Webhook HMAC verification

### Backup and Maintenance
- Automated backup execution with configurable destination
- Backup verification (integrity checks on completed archives)
- Shift reports (daily transaction summaries by email)
- Appliance restart with graceful shutdown and operator approval
- Pause/resume appliance operations

### Full Audit Trail
- Every session, turn, tool call, approval, and alert is persisted to `data/session.db`
- Full-text search across all conversation history via SQLite FTS5

---

## Requirements

- **Node.js** >= 20.0.0
- **COSA Pi:** Raspberry Pi (or any Linux machine) on the same LAN as the appliance
- **Appliance Pi:** Must expose `/health`, `/health/ready`, and `/api/status` HTTP endpoints, managed by systemd
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
appliance:
  name: "My POS"
  timezone: "America/Chicago"

ssh:
  host: "192.168.1.10"          # Appliance Pi LAN IP
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_ed25519_baanbaan"
  host_key_fingerprint: "SHA256:..."  # Strongly recommended — see below

appliance_api:
  base_url: "http://192.168.1.10:3000"
  status_endpoint: "/api/status"
  auth:
    type: "jwt"
    login_endpoint: "/api/auth/login"
    login_body_template: '{"email":"${credential:appliance_email}","password":"${credential:appliance_password}"}'
    refresh_endpoint: "/api/auth/refresh"
    refresh_body_template: '{"refreshToken":"${credential:appliance_refresh_token}"}'
    access_token_credential_key: "appliance_access_token"
    refresh_token_credential_key: "appliance_refresh_token"

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

Store the appliance credentials in COSA's encrypted credential store:

```bash
node cosa.js credentials set appliance_email your@email.com
node cosa.js credentials set appliance_password yourpassword
node cosa.js credentials set appliance_merchant_id merchant_123
```

#### Gmail setup (step by step)

COSA uses a Gmail App Password — a 16-character code that lets COSA connect to Gmail without knowing your Google account password. You generate it once and paste it into `.env`.

**Step 1 — Enable IMAP in Gmail**

1. Open Gmail and click the gear icon (top right) → **See all settings**
2. Click the **Forwarding and POP/IMAP** tab
3. Under "IMAP access", select **Enable IMAP**
4. Click **Save Changes**

**Step 2 — Enable 2-Step Verification on the Google account**

1. Go to your Google Account: click your profile picture → **Manage your Google Account**
2. Click the **Security** tab
3. Under "How you sign in to Google", click **2-Step Verification**
4. Follow the prompts to turn it on

**Step 3 — Generate an App Password**

1. Go back to your Google Account → **Security** tab → **2-Step Verification**
2. Scroll to the bottom and click **App passwords**
3. In the "App name" box, type `COSA`
4. Click **Create**
5. Copy the 16-character password and paste it into `.env` as `COSA_EMAIL_APP_PASSWORD` (remove spaces)

### 4. Configure the appliance context

Edit `config/APPLIANCE.md` to describe your deployment — LAN IPs, operator contact, deploy paths. This file is included verbatim in every agent session.

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
│   ├── main.js                     # Entry point — boot sequence and tool registration
│   ├── orchestrator.js             # Core agent loop (SAM pattern, Claude API, tool dispatch)
│   ├── context-builder.js          # System prompt assembly
│   ├── session-store.js            # SQLite persistence layer
│   ├── tool-registry.js            # Tool registration and dispatch
│   ├── security-gate.js            # Pre-execution security filter + output sanitizer
│   ├── approval-engine.js          # Operator approval FSM and token lifecycle
│   ├── appliance-auth.js           # Generic JWT / API-key auth with refresh-on-401
│   ├── watcher-registry.js         # Watcher storage, sandboxed execution, cooldown
│   ├── watcher-sandbox-worker.js   # Child-process vm worker (double-isolation sandbox)
│   ├── ssh-backend.js              # SSH connection pool to appliance
│   ├── credential-store.js         # Encrypted key-value store for secrets
│   ├── memory-manager.js           # Cross-session operator preferences
│   ├── context-compressor.js       # Mid-session Haiku summarization
│   ├── logger.js                   # Structured JSON logging
│   ├── interfaces/
│   │   ├── email-gateway.js        # IMAP polling + SMTP sending
│   │   └── cron-scheduler.js       # Scheduled tasks
│   └── tools/
│       ├── health-check.js         # health_check
│       ├── db-query.js             # db_query
│       ├── db-integrity.js         # db_integrity
│       ├── backup-run.js           # backup_run
│       ├── backup-verify.js        # backup_verify
│       ├── shift-report.js         # shift_report
│       ├── restart-appliance.js    # restart_appliance
│       ├── pause-appliance.js      # pause_appliance
│       ├── session-search.js       # session_search
│       ├── network-scan.js         # network_scan
│       ├── cloudflare-kill.js      # cloudflare_kill
│       ├── ips-alert.js            # ips_alert
│       ├── pci-assessment.js       # pci_assessment
│       ├── compliance-verify.js    # compliance_verify
│       ├── credential-audit.js     # credential_audit
│       ├── access-log-scan.js      # access_log_scan
│       ├── webhook-hmac-verify.js  # webhook_hmac_verify
│       ├── jwt-secret-check.js     # jwt_secret_check
│       ├── token-rotation-remind.js # token_rotation_remind
│       ├── process-monitor.js      # process_monitor
│       ├── settings-write.js       # settings_write
│       ├── appliance-status-poll.js # appliance_status_poll
│       ├── appliance-api-call.js   # appliance_api_call
│       ├── watcher-register.js     # watcher_register
│       ├── watcher-list.js         # watcher_list
│       ├── watcher-remove.js       # watcher_remove
│       └── watcher-set-enabled.js  # watcher_set_enabled
├── config/
│   ├── appliance.yaml              # Appliance adapter configuration
│   ├── cosa.config.js              # Config loader (env + yaml)
│   └── APPLIANCE.md                # Agent-readable appliance identity
├── data/
│   └── session.db                  # SQLite database (auto-created)
├── tests/
│   └── *.test.js                   # Unit tests
└── docs/
    ├── baanbaan_tools.md           # Generic Appliance Connector design doc
    ├── cosa_functional_spec.md     # Functional requirements
    └── cosa-architecture-proposal.md
```

---

## Architecture

COSA is built around a single agent loop: receive trigger → build system prompt → call Claude → process tool calls → return response. Complexity lives in the tools and security layers, not in the loop.

### Agent Loop (SAM Pattern)

The orchestrator implements the State-Action-Model pattern. Each session is a SAM instance with:
- **State:** conversation messages, pending tool calls, iteration counter, session status
- **Acceptors:** Claude response handler, tool result handler, iteration guard
- **NAPs (Next Actions):** sequential tool dispatch, Claude API call kickoff

Context is automatically compressed by Haiku when message size exceeds the threshold, replacing middle turns with a rolling summary while preserving full first and last turns.

### Security Layers

Every tool call passes through three gates in sequence:

1. **Security gate** — blocks dangerous command patterns before execution; optional Tirith scanner integration
2. **Approval gate** — routes medium/high/critical risk calls to operator via email; auto-approves read calls and email-triggered medium calls
3. **Output sanitizer** — strips credentials from tool output before LLM sees it

### Watcher Sandbox (Double Isolation)

Watcher predicates execute inside two nested isolation boundaries:

1. **Child process** — each watcher invocation spawns a fresh `node` subprocess; even a successful escape from the inner sandbox cannot reach COSA's credential store, database, or any in-memory state
2. **`vm.createContext`** inside the worker — strips `require`, `process`, `fetch`, and all Node globals from watcher scope, so casual escape attempts fail at the code level

### Data Model

`data/session.db` (SQLite):

| Table | Contents |
|-------|----------|
| `sessions` | One row per agent invocation — trigger type, status, timing |
| `turns` | Full conversation history per session (FTS5 indexed) |
| `tool_calls` | Every tool dispatch — input, output, status, risk level, approval ID |
| `approvals` | Approval request lifecycle — token, expiry, resolution |
| `alerts` | Outbound alert emails with deduplication metadata |
| `watchers` | Monitoring condition definitions — code, timestamps, trigger counts |
| `dead_letters` | Failed inbound emails for debugging |

### Appliance API Design

The Generic Appliance Connector uses a zero-hardcoding principle:
- No appliance-specific knowledge is compiled into COSA
- All endpoint names, paths, methods, risk levels, and body schemas live in `appliance.yaml`
- Claude picks the right endpoint by name; it cannot call anything not listed
- Path parameters are either static (resolved from the credential store, not overridable by Claude) or dynamic (explicitly designated as `caller` in config)

---

## Operator Modes

COSA supports two communication modes, configured via `COSA_OPERATOR_MODE` in `.env`:

| Mode | Audience | Email style |
|------|----------|-------------|
| `simple` (default) | Restaurant owners and managers | Plain business language. No technical jargon. Focuses on business impact. |
| `advanced` | Technically savvy operators or developers | Full technical detail — HTTP status codes, systemd states, SSH connectivity, database metrics, raw tool output. |

Switch modes at any time by editing `.env` and restarting COSA.

---

## Appliance Requirements

The Generic Appliance Connector requires the following endpoints on the appliance:

| Endpoint | Used by |
|----------|---------|
| `GET /health` | `health_check` |
| `GET /health/ready` | `health_check` |
| `GET /api/status` | `appliance_status_poll` (returns JSON snapshot for watchers) |
| Auth endpoints | `appliance_auth.js` (configured in `appliance.yaml`) |
| Allowlisted write endpoints | `appliance_api_call` (configured in `appliance.yaml`) |

The status endpoint should return a JSON object with the appliance's live state. The richer the object, the more useful the watcher system becomes. COSA treats the schema as opaque — Claude infers it on first poll.

---

## Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1 — Foundation | Health checks, email interface, approval system | Complete |
| 2 — Operate | Backup, shift reports, memory system, skill library | Complete |
| 3 — Secure | Intrusion detection, Cloudflare kill, PCI compliance | Complete |
| 4 — Connect | Generic REST connector, automated watcher monitoring | Complete |
| 5 — Evolve | AI-native memory, skill self-improvement, setup wizard | Planned |

---

## License

UNLICENSED — proprietary.
