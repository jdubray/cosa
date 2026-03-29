# COSA Phase 1: Technical and Functional Specification

**Version:** 0.2
**Date:** 2026-03-28
**Branch:** backend
**Status:** Phase 1 Specification — Open questions resolved

---

## 0. Purpose and Scope

This document is the implementation-level specification for **COSA Phase 1 — Foundation**. It translates the architectural proposals in `cosa-architecture-proposal.md` and `cosa_functional_spec.md` into concrete schemas, module contracts, interaction protocols, and acceptance tests that a developer can build from.

**Phase 1 exit criteria (from architecture proposal):**
> COSA can answer "is Baanbaan healthy?" autonomously, alert the operator by email if not, and accept email replies as approval tokens.

**What is in scope for Phase 1:**
- Core orchestration loop
- Session persistence (`session.db`)
- SSH backend to Baanbaan
- Email gateway (IMAP poll + SMTP send)
- Three OPERATE tools: `health_check`, `db_query`, `db_integrity`
- Baanbaan health API contract (COSA defines what Baanbaan must expose)
- Cron scheduler (1-hour health check only)
- Approval system (email token handshake)
- Dangerous command detection

**What is explicitly out of scope for Phase 1:**
- Memory system (MEMORY.md, skills.db) — Phase 2
- Context compression — Phase 2
- SECURE and CODE tool domains — Phases 3 and 4
- Layered prompt caching optimization — Phase 2
- CLI interface — Phase 2
- Backup, reporting, shift summaries — Phase 2

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     COSA Process (COSA Pi)                  │
│                                                             │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐  │
│  │ Email Gateway │   │ Cron Scheduler │   │ CLI (stub)   │  │
│  │ (IMAP poll + │   │ (1h health     │   │              │  │
│  │  SMTP send)  │   │  check)        │   │              │  │
│  └──────┬───────┘   └───────┬────────┘   └──────┬───────┘  │
│         │                   │                   │          │
│         └───────────────────┼───────────────────┘          │
│                             │                              │
│                    ┌────────▼────────┐                     │
│                    │   Orchestrator  │                     │
│                    │   (core loop)   │                     │
│                    └────────┬────────┘                     │
│                             │                              │
│         ┌───────────────────┼──────────────────┐           │
│         │                   │                  │           │
│  ┌──────▼──────┐   ┌────────▼───────┐  ┌───────▼───────┐  │
│  │  Security   │   │ Approval Engine│  │ Tool Registry │  │
│  │  Gate       │   │                │  │               │  │
│  └─────────────┘   └────────────────┘  └───────┬───────┘  │
│                                                │           │
│                                       ┌────────▼────────┐  │
│                                       │ SSH Backend     │  │
│                                       └────────┬────────┘  │
│                                                │           │
└────────────────────────────────────────────────┼───────────┘
                                                 │ SSH
                                        ┌────────▼────────┐
                                        │  Baanbaan Pi    │
                                        │  (appliance)    │
                                        └─────────────────┘
```

---

## 2. Module Breakdown

### 2.1 Directory Structure

```
cosa/
├── src/
│   ├── main.js                    # Entry point — starts interfaces and cron
│   ├── orchestrator.js            # Core agent loop
│   ├── context-builder.js         # Assembles the layered system prompt
│   ├── session-store.js           # session.db read/write
│   ├── tool-registry.js           # Tool registration, dispatch, schema
│   ├── security-gate.js           # Dangerous command detection
│   ├── approval-engine.js         # Approval FSM, token generation/verification
│   ├── ssh-backend.js             # SSH connection pool, command execution
│   ├── interfaces/
│   │   ├── email-gateway.js       # IMAP poll + SMTP send
│   │   └── cron-scheduler.js      # Cron runner
│   └── tools/
│       ├── health-check.js        # health_check tool
│       ├── db-query.js            # db_query tool
│       └── db-integrity.js        # db_integrity tool
├── config/
│   ├── appliance.yaml             # Baanbaan-specific adapter config
│   ├── cosa.config.js             # COSA runtime config (loaded from env + yaml)
│   └── APPLIANCE.md               # Agent-readable appliance identity context
├── data/
│   └── session.db                 # SQLite database (auto-created on first run)
├── package.json
└── .env                           # Credentials (never committed)
```

### 2.2 Module Responsibilities

| Module | Responsibility |
|---|---|
| `main.js` | Boot sequence: load config, run migrations, start email gateway poller, start cron scheduler |
| `orchestrator.js` | Core loop: receive trigger → build prompt → call Claude API → handle tool calls → route response |
| `context-builder.js` | Assemble layered system prompt from APPLIANCE.md, tool schemas, and optional memory context |
| `session-store.js` | CRUD on session.db — persist turns, tool calls, approvals; search via FTS5 |
| `tool-registry.js` | Register tools by name, validate inputs against JSON schema, dispatch to handler |
| `security-gate.js` | Block dangerous commands before tool execution; called by orchestrator before every tool dispatch |
| `approval-engine.js` | Determine whether a tool call needs approval; generate tokens; validate inbound approval replies |
| `ssh-backend.js` | Manage SSH connection to Baanbaan Pi; execute remote commands; return structured results |
| `email-gateway.js` | Poll IMAP inbox; parse operator messages; trigger orchestrator; send SMTP replies |
| `cron-scheduler.js` | Register cron expressions; fire orchestrator invocations on schedule |
| `health-check.js` | Run `GET /health`, `GET /health/ready`, process supervisor check, SSH connectivity check |
| `db-query.js` | Execute read-only SQLite SELECT via SSH on Baanbaan; return structured rows |
| `db-integrity.js` | Run `PRAGMA integrity_check` and `PRAGMA wal_checkpoint` via SSH; parse result |

---

## 3. Data Schema

### 3.1 `session.db`

SQLite database. Created at `data/session.db` on first run. All tables use `INTEGER PRIMARY KEY AUTOINCREMENT` for row IDs. WAL mode enabled.

#### Table: `sessions`

Represents a single agent invocation (one email, one cron tick, one CLI call).

```sql
CREATE TABLE sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL UNIQUE,         -- UUID v4
  parent_id      TEXT,                          -- for context compression continuity (Phase 2)
  trigger_type   TEXT NOT NULL,                 -- 'email' | 'cron' | 'cli'
  trigger_source TEXT,                          -- sender email, cron task name, or 'cli'
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'complete' | 'error'
  started_at     TEXT NOT NULL,                 -- ISO 8601
  completed_at   TEXT,
  summary        TEXT                           -- brief outcome summary (set on close)
);

CREATE INDEX idx_sessions_trigger_type ON sessions(trigger_type);
CREATE INDEX idx_sessions_started_at  ON sessions(started_at);
```

#### Table: `turns`

One row per message exchange (user turn or assistant turn) within a session.

```sql
CREATE TABLE turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(session_id),
  turn_index  INTEGER NOT NULL,                 -- 0-based within session
  role        TEXT NOT NULL,                    -- 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,                    -- message text or tool result (JSON)
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_turns_session_id ON turns(session_id);

-- FTS5 full-text index for cross-session search
CREATE VIRTUAL TABLE turns_fts USING fts5(
  content,
  session_id UNINDEXED,
  turn_index UNINDEXED,
  created_at UNINDEXED,
  content=turns,
  content_rowid=id
);
```

#### Table: `tool_calls`

One row per tool invocation (success or blocked).

```sql
CREATE TABLE tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  tool_name     TEXT NOT NULL,
  input         TEXT NOT NULL,                  -- JSON
  output        TEXT,                           -- JSON (null if blocked or pending)
  status        TEXT NOT NULL,                  -- 'executed' | 'blocked' | 'pending_approval' | 'denied' | 'expired'
  risk_level    TEXT,                           -- 'read' | 'medium' | 'high' | 'critical'
  approval_id   TEXT,                           -- FK to approvals if approval required
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_tool_name  ON tool_calls(tool_name);
CREATE INDEX idx_tool_calls_status     ON tool_calls(status);
```

#### Table: `approvals`

One row per approval request issued by COSA.

```sql
CREATE TABLE approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id     TEXT NOT NULL UNIQUE,          -- UUID v4
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  tool_call_id    INTEGER REFERENCES tool_calls(id),
  token           TEXT NOT NULL UNIQUE,          -- APPROVE-{8 char alphanumeric}
  tool_name       TEXT NOT NULL,
  action_summary  TEXT NOT NULL,                 -- human-readable description sent in email
  risk_level      TEXT NOT NULL,                 -- 'medium' | 'high' | 'critical'
  scope           TEXT NOT NULL DEFAULT 'once',  -- 'once' | 'session' | 'always'
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'denied' | 'expired'
  requested_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,                 -- ISO 8601 (default: 30 min from requested_at)
  resolved_at     TEXT,
  resolved_by     TEXT,                          -- operator email or 'system' (for timeout)
  operator_note   TEXT                           -- content of denial or note in reply
);

CREATE INDEX idx_approvals_token      ON approvals(token);
CREATE INDEX idx_approvals_status     ON approvals(status);
CREATE INDEX idx_approvals_expires_at ON approvals(expires_at);
```

#### Table: `alerts`

Outbound alerts sent to the operator. Separate from approval requests — alerts are one-way notifications.

```sql
CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(session_id),
  severity     TEXT NOT NULL,                   -- 'info' | 'warning' | 'critical'
  category     TEXT NOT NULL,                   -- 'health' | 'security' | 'backup' | 'approval'
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  sent_at      TEXT,                            -- null if not yet sent
  email_to     TEXT,
  email_msg_id TEXT                             -- SMTP message-id for threading
);
```

---

## 4. Configuration Schema

### 4.1 `config/appliance.yaml`

This file is the Baanbaan-specific adapter. Everything in it is Baanbaan-specific; changing it swaps the appliance.

```yaml
# config/appliance.yaml
appliance:
  name: "Baanbaan POS"
  timezone: "America/New_York"

ssh:
  host: "192.168.1.10"          # Baanbaan Pi LAN IP
  port: 22
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_ed25519_baanbaan"
  known_hosts_path: "/home/cosa/.ssh/known_hosts"
  connect_timeout_ms: 5000
  command_timeout_ms: 30000

appliance_api:
  base_url: "http://192.168.1.10:3000"  # direct LAN call — no SSH tunnel needed
  health_endpoint: "/health"
  health_ready_endpoint: "/health/ready"
  request_timeout_ms: 10000

database:
  path: "/home/baanbaan/app/data/baanbaan.db"  # path on Baanbaan Pi
  read_only: true

process_supervisor:
  type: "systemd"               # 'systemd' confirmed for Baanbaan
  service_name: "baanbaan"

operator:
  email: "owner@restaurant.com"
  name: "Restaurant Manager"
  approval_timeout_minutes: 30  # default approval window
  urgent_approval_timeout_minutes: 5

cron:
  health_check: "0 * * * *"    # every hour on the hour (Phase 1 only)

tools:
  health_check:
    enabled: true
    http_check: true
    process_check: true
    ssh_connectivity_check: true
  db_query:
    enabled: true
    max_row_return: 100
    query_timeout_ms: 15000
  db_integrity:
    enabled: true
    run_wal_checkpoint: true

security:
  dangerous_commands:
    - pattern: "rm\\s+-rf"
      reason: "Recursive delete"
    - pattern: "DROP\\s+TABLE"
      reason: "Destructive SQL"
    - pattern: "DROP\\s+DATABASE"
      reason: "Destructive SQL"
    - pattern: "DELETE\\s+FROM\\s+\\w+\\s*;"
      reason: "Unscoped delete (no WHERE clause)"
    - pattern: "killall|pkill|kill\\s+-9"
      reason: "Process kill"
    - pattern: "systemctl\\s+(stop|disable|mask)"
      reason: "Service stop"
    - pattern: "dd\\s+if="
      reason: "Raw disk operation"
    - pattern: "chmod\\s+777"
      reason: "Insecure permission set"
    - pattern: "curl.*\\|\\s*(bash|sh)"
      reason: "Remote code execution via pipe"
    - pattern: "(AWS_SECRET|API_KEY|PASSWORD|TOKEN)\\s*="
      reason: "Potential credential exposure"
```

### 4.2 `.env` (never committed)

```
# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Email — dedicated Gmail account for COSA (e.g. cosa.baanbaan@gmail.com)
# Use a Gmail App Password (not the account password):
#   Google Account → Security → 2-Step Verification → App Passwords
# Gmail IMAP must be enabled:
#   Gmail Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP
COSA_EMAIL_ADDRESS=cosa.baanbaan@gmail.com
COSA_EMAIL_IMAP_HOST=imap.gmail.com
COSA_EMAIL_IMAP_PORT=993
COSA_EMAIL_SMTP_HOST=smtp.gmail.com
COSA_EMAIL_SMTP_PORT=587
COSA_EMAIL_USERNAME=cosa.baanbaan@gmail.com
COSA_EMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   # Gmail App Password (16-char)

# Internal
COSA_DATA_DIR=./data
COSA_LOG_LEVEL=info
NODE_ENV=production
```

### 4.3 `config/APPLIANCE.md`

Agent-readable context included in every system prompt. Maintained manually at setup; updated by COSA autonomously in Phase 2+.

```markdown
# Baanbaan Appliance — Identity

**System:** Baanbaan POS Relay
**Runtime:** Bun on Raspberry Pi 4 (ARM64)
**OS:** Raspberry Pi OS (Bookworm)
**Deploy path:** /home/baanbaan/app
**Database:** SQLite at /home/baanbaan/app/data/baanbaan.db
**Process supervisor:** systemd (service name: baanbaan)
**API:** HTTP on port 3000
**External POS:** Clover via REST API
**Cloudflare tunnel:** managed by cloudflared (service: cloudflared)

## Network
**LAN IP:** 192.168.1.10
**COSA Pi IP:** 192.168.1.11
**Router:** 192.168.1.1

## Contacts
**Operator:** owner@restaurant.com

## Known State
Last verified healthy: (COSA will update this field after each health check)
```

---

## 5. Orchestrator Loop

### 5.1 Pseudocode

```javascript
/**
 * @param {Object} trigger - { type: 'email'|'cron'|'cli', source: string, message: string }
 * @returns {Promise<string>} final response to route back to caller
 */
async function runSession(trigger) {
  const sessionId = generateUuid()
  await sessionStore.createSession(sessionId, trigger)

  const systemPrompt = contextBuilder.build()     // APPLIANCE.md + tool schemas + identity
  const messages = [{ role: 'user', content: trigger.message }]

  let iterations = 0
  const MAX_ITERATIONS = 20

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await anthropic.messages.create({
      model: config.models.default,               // claude-sonnet-4-6
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolRegistry.getSchemas(),
      messages
    })

    await sessionStore.saveTurn(sessionId, 'assistant', response)

    if (response.stop_reason === 'end_turn') {
      const finalText = extractText(response)
      await sessionStore.closeSession(sessionId, finalText)
      return finalText
    }

    if (response.stop_reason === 'tool_use') {
      for (const toolCall of extractToolCalls(response)) {
        const toolResult = await dispatchTool(sessionId, toolCall)
        messages.push({ role: 'tool', content: toolResult })
        await sessionStore.saveToolCall(sessionId, toolCall, toolResult)
      }
      messages.push({ role: 'assistant', content: response.content })
    }
  }

  // Max iterations reached — surface to operator
  await sessionStore.closeSession(sessionId, 'Max iterations reached')
  return 'Reached iteration limit. Please send another message to continue.'
}

async function dispatchTool(sessionId, toolCall) {
  // 1. Security gate — block dangerous commands
  const danger = securityGate.check(toolCall)
  if (danger.blocked) {
    await sessionStore.recordBlockedToolCall(sessionId, toolCall, danger.reason)
    return { error: `Blocked: ${danger.reason}` }
  }

  // 2. Approval gate — check if this tool/risk level requires approval
  const approvalPolicy = approvalEngine.requiresApproval(toolCall)
  if (approvalPolicy !== 'auto') {
    const approval = await approvalEngine.requestApproval(sessionId, toolCall, approvalPolicy)
    if (approval.status !== 'approved') {
      return { error: `Not approved: ${approval.status}` }
    }
  }

  // 3. Execute tool
  const result = await toolRegistry.dispatch(toolCall.name, toolCall.input)

  // 4. Sanitize output (strip credential patterns)
  return securityGate.sanitizeOutput(result)
}
```

### 5.2 Model Selection

| Decision type | Model |
|---|---|
| Routine query, health check, report generation | `claude-sonnet-4-6` |
| High-stakes decision (Phase 3+ intrusion response) | `claude-opus-4-6` |
| Context compression summarization (Phase 2) | `claude-haiku-4-5-20251001` |

Phase 1 uses `claude-sonnet-4-6` exclusively — no critical decisions require Opus yet.

---

## 6. Email Gateway

### 6.1 IMAP Poller

The email account is a dedicated Gmail account (e.g. `cosa.baanbaan@gmail.com`) set up by the operator. Authentication uses a Gmail App Password — a 16-character application-specific password generated in Google Account security settings. This avoids OAuth2 complexity while maintaining 2FA on the account.

**Gmail configuration required:**
- IMAP access enabled (Gmail Settings → Forwarding and POP/IMAP)
- 2-Step Verification on (prerequisite for App Passwords)
- App Password generated for "Mail" application

Polls the COSA inbox every 60 seconds. New messages from the configured operator address trigger an orchestrator session. Non-operator senders are silently ignored and logged.

```javascript
/**
 * Poll cadence: every 60 seconds
 * Marks processed messages as READ after dispatching
 * Threads: maintains In-Reply-To/References headers for email threading
 */
async function pollInbox() {
  const messages = await imap.fetchUnread({ from: config.operator.email })
  for (const msg of messages) {
    const isApprovalReply = approvalEngine.looksLikeApprovalToken(msg.text)
    if (isApprovalReply) {
      await approvalEngine.processInboundReply(msg)
    } else {
      const response = await orchestrator.runSession({
        type: 'email',
        source: msg.from,
        message: msg.text,
        replyTo: msg.messageId
      })
      await smtp.send({
        to: msg.from,
        subject: `Re: ${msg.subject}`,
        inReplyTo: msg.messageId,
        text: response
      })
    }
    await imap.markRead(msg.uid)
  }
}
```

### 6.2 Token Detection

The approval engine uses a lightweight check before invoking the full session logic:

```javascript
// Returns true if the message body contains an approval/denial token
function looksLikeApprovalToken(text) {
  return /\bAPPROVE-[A-Z0-9]{8}\b/i.test(text) || /\bDENY\b/i.test(text)
}
```

### 6.3 SMTP Sender

```javascript
/**
 * @param {Object} options
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} [options.inReplyTo]   - message-id for threading
 * @param {string} [options.references]  - prior message-ids for threading
 */
async function send(options) { /* ... */ }
```

All outbound emails are plain text. No HTML. No attachments in Phase 1.

### 6.4 Outbound Email Types (Phase 1)

| Type | Trigger | Subject prefix |
|---|---|---|
| Query response | Inbound operator email | `Re: [original subject]` |
| Health alert | Cron detects anomaly | `[COSA] Alert: [appliance name]` |
| Approval request | Tool call requires approval | `[COSA] Approval Needed: [action]` |
| Approval confirmation | Approval executed | `[COSA] Done: [action]` |
| Approval denied | Operator replied DENY | `[COSA] Cancelled: [action]` |
| Approval expired | No response within timeout | `[COSA] Expired: [action] (auto-denied)` |

---

## 7. Approval System

### 7.1 Risk Classification

Every tool in the registry declares a `riskLevel`. The approval policy is determined by the combination of tool risk and operational context:

| Risk Level | Default Policy | Examples |
|---|---|---|
| `read` | `auto` (no approval needed) | `health_check`, `db_query`, `db_integrity` |
| `medium` | `once` (approval for this invocation) | `backup_run`, `cache_flush` (Phase 2) |
| `high` | `once` + operator confirmation | `deploy`, `restart_appliance` (Phase 4) |
| `critical` | `once` + urgent (5 min timeout) | `cloudflare_kill`, `pause_appliance` (Phase 3) |

In Phase 1, all three implemented tools are `read` — no approval requests will be generated by tool dispatch. The approval system is implemented and tested via a synthetic `_test_approval_request` trigger only, not from live tool calls. This validates the full email token handshake before Phase 2 tools that actually need it.

### 7.2 Token Format

```
APPROVE-{8 uppercase alphanumeric characters}

Examples:
  APPROVE-A3KX9ZQM
  APPROVE-7TBPWR2N
```

Generated using `crypto.randomBytes(4).toString('hex').toUpperCase()` for 8 hex chars (32 bits of entropy). Tokens are single-use and time-limited.

### 7.3 Approval FSM

```
                    ┌─────────────────┐
                    │    PENDING      │◀──────────────────────┐
                    │                 │                       │
                    │ token sent      │                       │ new approval
                    │ awaiting reply  │                       │ request
                    └────────┬────────┘                       │
                             │                               │
              ┌──────────────┼─────────────────┐
              │              │                 │
         (reply with    (reply with     (no reply within
         APPROVE-token)    DENY)           timeout window)
              │              │                 │
              ▼              ▼                 ▼
        ┌──────────┐   ┌──────────┐    ┌──────────────┐
        │ APPROVED │   │  DENIED  │    │   EXPIRED    │
        │          │   │          │    │              │
        │ execute  │   │ log +    │    │ log +        │
        │ tool +   │   │ notify   │    │ notify       │
        │ confirm  │   │ operator │    │ operator     │
        └──────────┘   └──────────┘    └──────────────┘
```

### 7.4 Approval Request Email Template

```
Subject: [COSA] Approval Needed: {action title}

What COSA wants to do:
  {action_summary}

Why:
  {reasoning}

Risk level: {risk_level}

If you approve, reply to this email with:
  APPROVE-{TOKEN}

If you deny, reply with: DENY [optional reason]

This request expires in {timeout_minutes} minutes.
If no response is received, the action will be automatically cancelled.

---
Reference: {approval_id}
Session: {session_id}
```

### 7.5 Approval Processing

When the IMAP poller detects an approval reply:

```javascript
async function processInboundReply(msg) {
  const text = msg.text.trim().toUpperCase()

  // Extract token
  const approveMatch = text.match(/\bAPPROVE-([A-Z0-9]{8})\b/)
  const isDeny = /\bDENY\b/.test(text)

  if (!approveMatch && !isDeny) {
    // Ambiguous — respond asking for clarification
    await smtp.send({ to: msg.from, subject: 'Re: ...', text: 'Reply not understood. Please reply with APPROVE-TOKEN or DENY.' })
    return
  }

  if (approveMatch) {
    const token = `APPROVE-${approveMatch[1]}`
    const approval = await sessionStore.findApprovalByToken(token)

    if (!approval) {
      await smtp.send({ to: msg.from, text: 'Token not found or already used.' })
      return
    }

    if (approval.status !== 'pending') {
      await smtp.send({ to: msg.from, text: `This approval is already ${approval.status}.` })
      return
    }

    if (new Date() > new Date(approval.expires_at)) {
      await sessionStore.updateApprovalStatus(approval.approval_id, 'expired')
      await smtp.send({ to: msg.from, text: 'This approval token has expired. Please re-request if you still want COSA to proceed.' })
      return
    }

    // Valid, unexpired — approve
    await sessionStore.updateApprovalStatus(approval.approval_id, 'approved', msg.from)
    await resumeApprovalWaiter(approval)    // unblocks the waiting orchestrator session
    await smtp.send({ to: msg.from, text: `Approved. COSA will proceed with: ${approval.action_summary}` })
  }

  if (isDeny) {
    // Extract the token from the quoted original email in the reply
    const originalToken = extractTokenFromQuotedEmail(msg.text)
    if (originalToken) {
      const approval = await sessionStore.findApprovalByToken(originalToken)
      if (approval && approval.status === 'pending') {
        const note = text.replace(/DENY/, '').trim()
        await sessionStore.updateApprovalStatus(approval.approval_id, 'denied', msg.from, note)
        await resumeApprovalWaiter(approval)
        await smtp.send({ to: msg.from, text: `Understood. Action cancelled: ${approval.action_summary}` })
      }
    }
  }
}
```

---

## 8. Security Gate

### 8.1 Dangerous Command Check

Applied to every tool call before execution. Checks the full stringified tool input against the patterns defined in `appliance.yaml`.

```javascript
/**
 * @param {Object} toolCall - { name: string, input: Object }
 * @returns {{ blocked: boolean, reason?: string }}
 */
function check(toolCall) {
  const inputStr = JSON.stringify(toolCall.input)
  for (const rule of config.security.dangerous_commands) {
    if (new RegExp(rule.pattern, 'i').test(inputStr)) {
      return { blocked: true, reason: rule.reason, pattern: rule.pattern }
    }
  }
  return { blocked: false }
}
```

### 8.2 Output Sanitization

Before any tool output is appended to the conversation history:

```javascript
const CREDENTIAL_PATTERNS = [
  /\b(sk-ant-[A-Za-z0-9]{20,})\b/g,   // Anthropic API key
  /\b([A-Za-z0-9]{40})\b(?=.*secret)/gi, // Generic secret
  /password\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*\S+/gi,
]

function sanitizeOutput(output) {
  let str = typeof output === 'string' ? output : JSON.stringify(output)
  for (const pattern of CREDENTIAL_PATTERNS) {
    str = str.replace(pattern, '[REDACTED]')
  }
  return str
}
```

---

## 9. SSH Backend

### 9.1 Connection Pool

The SSH backend maintains a single persistent connection per appliance. It reconnects automatically on disconnect with exponential backoff (1s, 2s, 4s, max 30s).

```javascript
/**
 * Execute a command on the Baanbaan Pi via SSH.
 * @param {string} command - shell command to run (must not contain user-controlled content)
 * @param {Object} [options]
 * @param {number} [options.timeout_ms] - override default command timeout
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function exec(command, options = {}) { /* ... */ }
```

**Security constraint:** `command` must be a static string defined in a tool handler, never constructed from user input or LLM output. The LLM cannot inject commands into the SSH backend; it can only invoke named tools that call `exec` with pre-defined commands.

### 9.2 Connection Health

`ssh-backend.js` exposes a `isConnected()` method. If SSH is not reachable, tools return a structured error that COSA can report to the operator. The health check tool explicitly tests SSH connectivity as step 1.

---

## 10. Tool Specifications

### 10.1 `health_check`

**Purpose:** Verify that Baanbaan is running and healthy. Checks HTTP health endpoints and the process supervisor.

**Risk level:** `read` — no approval required.

**Input schema:**
```json
{
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false
}
```
(No input parameters — always runs against the configured appliance.)

**Execution steps (in order):**

Steps 1–3 run in parallel; step 4 runs sequentially after step 1 succeeds.

1. **SSH connectivity:** Confirm `ssh-backend.isConnected()`. If not, attempt reconnect (3 retries with 2s backoff). All subsequent steps depend on this.
2. **HTTP health:** Direct LAN HTTP call `GET {appliance_api.base_url}/health` with `timeout: 10s`. No SSH tunnel needed — COSA Pi and Baanbaan Pi are on the same network. Parse JSON body.
3. **HTTP ready:** Direct LAN HTTP call `GET {appliance_api.base_url}/health/ready` with `timeout: 10s`. Parse `ready` boolean from JSON body.
4. **Process supervisor:** Via SSH (requires step 1), run `systemctl show baanbaan --property=ActiveState,SubState,ExecMainStartTimestamp,NRestarts`. Parse key=value output. Compute `uptime_seconds` from `ExecMainStartTimestamp` vs. current time.

**Output schema:**
```json
{
  "type": "object",
  "properties": {
    "overall_status":  { "type": "string", "enum": ["healthy", "degraded", "unreachable"] },
    "ssh_connected":   { "type": "boolean" },
    "http_health":     {
      "type": "object",
      "properties": {
        "reachable": { "type": "boolean" },
        "status_code": { "type": "integer" },
        "body": { "type": "object" }
      }
    },
    "http_ready":      {
      "type": "object",
      "properties": {
        "reachable": { "type": "boolean" },
        "status_code": { "type": "integer" },
        "body": { "type": "object" }
      }
    },
    "process": {
      "type": "object",
      "properties": {
        "running": { "type": "boolean" },
        "active_state": { "type": "string", "description": "systemd ActiveState: active | failed | inactive | activating | deactivating" },
        "sub_state": { "type": "string", "description": "systemd SubState: running | dead | exited | etc." },
        "started_at": { "type": "string", "format": "date-time" },
        "uptime_seconds": { "type": "integer" },
        "restarts": { "type": "integer", "description": "NRestarts from systemd unit" }
      }
    },
    "errors": { "type": "array", "items": { "type": "string" } },
    "checked_at": { "type": "string", "format": "date-time" }
  }
}
```

**`overall_status` logic:**
- `healthy` — SSH connected, both HTTP checks return 200, systemd unit `ActiveState=active SubState=running`, restarts = 0
- `degraded` — One or more checks warn (non-200 HTTP, process has recent restarts, slow response)
- `unreachable` — SSH not connected, or HTTP completely fails

### 10.2 `db_query`

**Purpose:** Execute a read-only SQL `SELECT` statement against the Baanbaan SQLite database via SSH.

**Risk level:** `read` — no approval required.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "A SQL SELECT statement. Must start with SELECT. No DML or DDL allowed."
    },
    "limit": {
      "type": "integer",
      "default": 50,
      "maximum": 100,
      "description": "Maximum rows to return."
    }
  },
  "required": ["query"]
}
```

**Validation (before execution):**
1. Trim and uppercase the first token — must be `SELECT`.
2. Check for destructive keywords: `DROP`, `DELETE`, `UPDATE`, `INSERT`, `CREATE`, `ALTER`, `ATTACH`. Reject if found.
3. Enforce row limit by appending `LIMIT {limit}` if not already present.

**Execution:** Via SSH (Baanbaan user has direct read access — no sudo required):
```bash
sqlite3 -json -readonly {database.path} "{sanitized_query}"
```

**Output schema:**
```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": { "type": "object" }
    },
    "row_count": { "type": "integer" },
    "truncated": { "type": "boolean" },
    "query_time_ms": { "type": "integer" }
  }
}
```

### 10.3 `db_integrity`

**Purpose:** Run SQLite integrity and WAL checkpoint checks on the Baanbaan database.

**Risk level:** `read` — `PRAGMA integrity_check` and `PRAGMA wal_checkpoint(PASSIVE)` are non-destructive.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "run_wal_checkpoint": {
      "type": "boolean",
      "default": true,
      "description": "Whether to run PRAGMA wal_checkpoint(PASSIVE) after integrity check."
    }
  },
  "required": []
}
```

**Execution:** Via SSH:
```bash
sqlite3 {database.path} "PRAGMA integrity_check;"
# if run_wal_checkpoint:
sqlite3 {database.path} "PRAGMA wal_checkpoint(PASSIVE);"
```

**Output schema:**
```json
{
  "type": "object",
  "properties": {
    "integrity": {
      "type": "string",
      "description": "'ok' means no corruption. Any other value is a corruption report."
    },
    "is_healthy": { "type": "boolean" },
    "wal_checkpoint": {
      "type": "object",
      "properties": {
        "ran": { "type": "boolean" },
        "busy": { "type": "integer" },
        "log": { "type": "integer" },
        "checkpointed": { "type": "integer" }
      }
    },
    "errors": { "type": "array", "items": { "type": "string" } },
    "checked_at": { "type": "string", "format": "date-time" }
  }
}
```

---

## 11. Cron Scheduler

### 11.1 Phase 1 Schedule

Only one cron task in Phase 1:

| Task | Expression | Description |
|---|---|---|
| `health-check` | `0 * * * *` | Every hour on the hour |

### 11.2 Cron Trigger Message

When a cron task fires, it invokes the orchestrator with a structured trigger message rather than a user message. The system prompt is assembled with the cron context so the LLM knows what it's doing.

```javascript
{
  type: 'cron',
  source: 'health-check',
  message: `You are running the scheduled hourly health check for Baanbaan.

Run the health_check tool to assess the appliance state. If the result is healthy, log it and take no further action. If degraded or unreachable, diagnose using db_integrity if needed, then send an alert email to the operator with the findings and recommendations.

Current time: ${new Date().toISOString()}`
}
```

### 11.3 Cron Alert Condition

After the health check session completes:
- If `overall_status === 'healthy'`: log to `session.db`, send no email.
- If `overall_status === 'degraded'` or `'unreachable'`: send alert email to operator.

To prevent alert floods, the scheduler tracks the last alert sent for each alert category. A new alert is suppressed if:
- An alert for the same category was sent less than 60 minutes ago, AND
- The condition has not changed severity since the last alert.

---

## 12. Context Builder

### 12.1 System Prompt Assembly (Phase 1)

In Phase 1, the system prompt is simpler than the full layered architecture (which comes in Phase 2 with MEMORY.md and skill index). The Phase 1 prompt has these layers:

```
Layer 0: COSA core identity (static — cached indefinitely)
Layer 1: APPLIANCE.md content (cached per session)
Layer 2: Tool schemas (filtered to enabled tools)
Layer 3: Current date/time
```

```javascript
function build() {
  return [
    COSA_IDENTITY,           // static string, defined in src/prompts/identity.js
    loadApplianceMd(),       // reads config/APPLIANCE.md
    formatToolSchemas(),     // only tools with enabled: true in config
    `Current time: ${new Date().toISOString()}`
  ].join('\n\n---\n\n')
}
```

### 12.2 COSA Identity (Layer 0)

```
You are COSA (Code-Operate-Secure Agent), an autonomous operations agent managing a software appliance.

Your primary responsibilities:
- Monitor and assess appliance health
- Diagnose issues and propose remedies
- Report findings to the operator via email
- Request operator approval before taking any non-read action

Your operating principles:
- Default to read-only operations. Never modify state without operator approval.
- Be concise and factual. Operators are busy; surface only what matters.
- When in doubt, ask. It is better to ask for approval than to act without consent.
- Dangerous commands (rm -rf, DROP TABLE, credential exposure) are blocked by the security gate. Never attempt to circumvent it.
- All your actions are logged and auditable. Operate with full transparency.

Communication style:
- Plain text only. No markdown formatting in emails.
- Lead with the conclusion ("Baanbaan is healthy." / "Alert: POS adapter offline.").
- Follow with evidence and detail.
- End with a clear next-step recommendation if action is needed.
```

---

## 13. Logging

All log output goes to stdout in structured JSON format.

```json
{
  "ts": "2026-03-28T14:30:00.000Z",
  "level": "info",
  "module": "email-gateway",
  "msg": "Inbound email from operator",
  "from": "owner@restaurant.com",
  "subject": "How is the printer doing?"
}
```

Levels: `debug`, `info`, `warn`, `error`.

In Phase 1, logs are written to stdout only. Log file rotation is out of scope.

---

## 14. Startup Sequence

`main.js` executes in this order:

1. Load `appliance.yaml` and `.env`.
2. Validate required config fields. Exit with error if any missing.
3. Run database migrations (create tables if not exist).
4. Test SSH connectivity to Baanbaan Pi. Log result (warning only — do not crash if SSH is unreachable at startup).
5. Start IMAP poller (non-blocking background loop).
6. Register cron tasks.
7. Log: "COSA ready. Monitoring [appliance name]."

---

## 15. Functional Scenarios

These are the Phase 1 acceptance test scenarios. Each scenario is runnable in a staging environment.

---

### Scenario F-1: Operator Queries Health via Email

**Preconditions:**
- COSA is running
- Baanbaan Pi is running and healthy
- SSH connectivity between COSA Pi and Baanbaan Pi is established

**Trigger:**
Operator sends email to COSA inbox:
```
Subject: Quick check
Body: Is Baanbaan running okay right now?
```

**Expected COSA behavior:**
1. IMAP poller detects inbound email within 60 seconds.
2. Orchestrator session starts (`trigger.type = 'email'`).
3. COSA calls `health_check` tool.
4. `health_check` returns `overall_status: 'healthy'`.
5. COSA composes reply and SMTP sends it within 2 minutes of email receipt.

**Expected reply:**
```
Subject: Re: Quick check

Baanbaan is healthy.

Checks passed:
- SSH: connected
- HTTP /health: 200 OK
- HTTP /health/ready: 200 OK
- Process (systemd baanbaan): running, uptime 3h 42m, 0 restarts

No issues detected.
```

**Verification:**
- `sessions` table: one row with `trigger_type = 'email'`, `status = 'complete'`
- `tool_calls` table: one row with `tool_name = 'health_check'`, `status = 'executed'`
- Reply email received in operator inbox within 2 minutes

---

### Scenario F-2: Cron Health Check — Appliance Healthy

**Preconditions:**
- COSA is running
- Baanbaan Pi is running and healthy
- Cron scheduler set to `0 * * * *`

**Trigger:**
Cron fires at the top of the hour.

**Expected COSA behavior:**
1. Cron scheduler invokes orchestrator with health check trigger message.
2. COSA calls `health_check` tool.
3. `health_check` returns `overall_status: 'healthy'`.
4. COSA logs success to `session.db`.
5. COSA sends no email.

**Verification:**
- `sessions` table: one row with `trigger_type = 'cron'`, `trigger_source = 'health-check'`, `status = 'complete'`
- `alerts` table: no new row created
- Operator inbox: no email received

---

### Scenario F-3: Cron Health Check — Appliance Unreachable

**Preconditions:**
- COSA is running
- Baanbaan Pi is stopped or SSH is unavailable (simulated by blocking port 22)

**Trigger:**
Cron fires at the top of the hour.

**Expected COSA behavior:**
1. Cron fires, orchestrator invoked.
2. COSA calls `health_check`.
3. SSH connection fails; `health_check` returns `overall_status: 'unreachable'`.
4. COSA composes alert and sends email to operator.
5. Alert recorded in `alerts` table.

**Expected alert email:**
```
Subject: [COSA] Alert: Baanbaan

Baanbaan is unreachable.

SSH connection to 192.168.1.10 failed (timeout after 5s, 3 retries).
HTTP health checks could not be run.

Possible causes:
- Raspberry Pi has crashed or powered off
- Network connectivity issue on the LAN
- SSH service stopped

Recommended action:
- Physically check that the Baanbaan Pi is powered on
- Check LAN connectivity (router admin panel)
- If Pi is on and accessible, SSH manually and check: systemctl status baanbaan

I will check again in 1 hour and alert you if the issue persists.
```

**Verification:**
- `alerts` table: one row with `severity = 'critical'`, `category = 'health'`, `sent_at` populated
- Operator inbox: alert email received within 5 minutes of cron firing
- Second cron fires 1 hour later — if appliance still unreachable, another alert sent; if healthy, no email

---

### Scenario F-4: Cron Health Check — Appliance Degraded

**Preconditions:**
- COSA is running
- Baanbaan Pi is running, SSH connected, but `GET /health` returns 200 with `{ "status": "degraded", "details": { "memory_usage_pct": 92 } }`

**Expected alert email:**
```
Subject: [COSA] Alert: Baanbaan

Baanbaan is degraded.

Health check findings:
- SSH: connected
- HTTP /health: 200 OK, status: degraded
  Memory usage: 92% (threshold: 80%)
- HTTP /health/ready: 200 OK
- Process (systemd baanbaan): running, uptime 14h 23m, 0 restarts

No immediate action required, but memory pressure may cause slowdowns.

Recommended action:
- Monitor for the next 2 hours; if usage continues to climb, a service restart may be warranted
- Reply "restart baanbaan" if you want me to schedule a graceful restart (requires approval)
```

---

### Scenario F-5: Operator Approval Handshake

**Preconditions:**
- COSA is running
- An approval request was previously issued (can be triggered synthetically via CLI for testing)
- Approval token: `APPROVE-A3KX9ZQM`, expires in 30 minutes, status: `pending`

**Trigger:**
Operator sends reply email:
```
Subject: Re: [COSA] Approval Needed: Test action
Body: APPROVE-A3KX9ZQM
```

**Expected COSA behavior:**
1. IMAP poller detects reply within 60 seconds.
2. `approvalEngine.looksLikeApprovalToken()` returns `true`.
3. Token parsed: `APPROVE-A3KX9ZQM`.
4. Token looked up in `approvals` table → found, `status = 'pending'`, not expired.
5. Status updated to `approved`, `resolved_by` set to operator email.
6. Waiting orchestrator session unblocked (if synchronous) or flagged for resumption.
7. Confirmation email sent.

**Expected confirmation email:**
```
Subject: Re: [COSA] Approval Needed: Test action

Approved. Proceeding with: [action summary].

I'll notify you when complete.
```

**Verification:**
- `approvals` table: `status = 'approved'`, `resolved_at` populated, `resolved_by` = operator email

---

### Scenario F-6: Approval Denied

**Trigger:**
Operator sends reply:
```
Subject: Re: [COSA] Approval Needed: Test action
Body: DENY — not the right time for this change
```

**Expected confirmation email:**
```
Subject: Re: [COSA] Approval Needed: Test action

Understood. Action cancelled: [action summary].

Your note: "not the right time for this change"

I've recorded your decision. If you'd like me to proceed later, just send me a new request.
```

---

### Scenario F-7: Approval Expired

**Preconditions:**
- Approval request issued with 30-minute timeout
- Operator takes no action

**Trigger:**
Background expiry check (runs every 5 minutes) finds approval past its `expires_at`.

**Expected behavior:**
1. Approval status updated to `expired`.
2. Notification email sent to operator.

**Expected notification email:**
```
Subject: [COSA] Expired: [action title]

The approval request for "[action summary]" has expired (no response within 30 minutes).

The action has been automatically cancelled. If you still want me to proceed, please send me a new request.
```

---

### Scenario F-8: Dangerous Command Blocked

**Preconditions:**
- COSA is running
- Operator sends an email that leads the LLM to attempt a dangerous tool call (simulated via test injection)

**Simulated tool call:**
```json
{ "name": "db_query", "input": { "query": "DROP TABLE orders;" } }
```

**Expected behavior:**
1. Security gate checks input against dangerous command patterns.
2. Matches `DROP\\s+TABLE` rule.
3. Tool call blocked; `tool_calls` record created with `status = 'blocked'`, `risk_level = null`.
4. Error returned to LLM conversation: `"Blocked: Destructive SQL"`
5. LLM responds to operator explaining the command was blocked for safety reasons.

**Verification:**
- `tool_calls` table: one row with `status = 'blocked'`
- No actual SQLite command executed on Baanbaan
- Operator receives response explaining the action was blocked

---

## 16. Non-Functional Requirements

| Requirement | Target | Notes |
|---|---|---|
| Email response time | < 2 minutes from receipt | IMAP poll every 60s + LLM time |
| Health alert time | < 5 minutes from anomaly | Cron runs hourly; alert sent immediately on detection |
| Session.db write durability | Synchronous (WAL + fsync) | No data loss on crash |
| SSH reconnect time | < 30 seconds | Exponential backoff, max 3 retries |
| LLM API timeout | 60 seconds per call | Abort and log if exceeded |
| Approval token entropy | 32 bits (8 hex chars) | `crypto.randomBytes(4)` |
| Approval expiry check | Every 5 minutes | Background timer in main.js |
| Dangerous command regex | < 1ms per check | In-process, no I/O |

---

## 17. Development and Testing Guide

### 17.1 Local Development Setup

```bash
# Clone and install
git clone ...
cd cosa
bun install

# Configure
cp config/appliance.yaml.example config/appliance.yaml
cp .env.example .env
# Edit both files with actual values

# Run database migrations
bun run migrate

# Start COSA
bun run dev
```

### 17.2 Test Strategy (TDD)

All modules have unit tests. Integration tests use a mock SSH backend and a mock SMTP/IMAP server.

**Unit test coverage targets (Phase 1):**
- `security-gate.js` — 100% (all regex patterns have positive and negative test cases)
- `approval-engine.js` — 100% (all FSM transitions, token generation, expiry logic)
- `tool-registry.js` — 90%
- `ssh-backend.js` — 80% (SSH interactions mocked)
- `email-gateway.js` — 80% (IMAP/SMTP mocked)

**Integration test scenarios (must pass before Phase 1 is complete):**
All 8 functional scenarios in §15 must be verified in a staging environment with a real (or simulated) Baanbaan Pi.

### 17.3 Staging Environment

For integration testing, use:
- A Raspberry Pi on the local dev LAN running the Baanbaan app (or a Docker container emulating the health endpoints)
- A test email account (not the production operator address)
- `NODE_ENV=staging` in `.env` to use shorter approval timeouts (2 minutes instead of 30)

---

## 18. Required Baanbaan API Contract

COSA has carte blanche to define the interface Baanbaan must expose. The following is the minimum contract for Phase 1. These endpoints must be implemented in Baanbaan before COSA Phase 1 can be tested end-to-end.

### 18.1 HTTP Health Endpoints

Baanbaan must expose two HTTP endpoints on `localhost:3000` (not internet-exposed — COSA queries via SSH port-forward or direct LAN HTTP call):

#### `GET /health`

Returns overall liveness of the process.

**Response `200 OK`:**
```json
{
  "status": "ok",
  "uptime_seconds": 14523,
  "version": "1.4.2",
  "timestamp": "2026-03-28T14:30:00.000Z"
}
```

**Response `200 OK` (degraded — process running but internals warn):**
```json
{
  "status": "degraded",
  "uptime_seconds": 14523,
  "version": "1.4.2",
  "timestamp": "2026-03-28T14:30:00.000Z",
  "warnings": ["memory_usage_pct:92", "db_pool_wait_ms:450"]
}
```

If the process is completely dead, this endpoint is unreachable (connection refused) — that is the signal itself.

#### `GET /health/ready`

Returns whether Baanbaan can accept and process orders right now (deeper readiness check).

**Response `200 OK`:**
```json
{
  "ready": true,
  "checks": {
    "database": "ok",
    "pos_adapter": "ok",
    "cloudflare_tunnel": "ok"
  },
  "timestamp": "2026-03-28T14:30:00.000Z"
}
```

**Response `200 OK` (not ready):**
```json
{
  "ready": false,
  "checks": {
    "database": "ok",
    "pos_adapter": "timeout",
    "cloudflare_tunnel": "ok"
  },
  "timestamp": "2026-03-28T14:30:00.000Z"
}
```

Note: returns HTTP 200 in both cases — the `ready` boolean is the signal. COSA does not rely on HTTP status codes for readiness; it parses the JSON body.

### 18.2 systemd Service Unit

Baanbaan is managed by systemd. The service unit must be named `baanbaan` and installed at `/etc/systemd/system/baanbaan.service`. COSA checks health via:

```bash
systemctl show baanbaan --property=ActiveState,SubState,ExecMainStartTimestamp,NRestarts
```

Expected output when healthy:
```
ActiveState=active
SubState=running
ExecMainStartTimestamp=Fri 2026-03-27 20:00:00 UTC
NRestarts=0
```

The `baanbaan` SSH user must be able to run `systemctl show baanbaan` without `sudo` (read-only systemd properties do not require elevated privileges on standard systemd installations).

COSA does **not** invoke `systemctl restart` or `systemctl stop` directly. Service restarts are handled by the `restart_appliance` tool (Phase 2), which is a write operation requiring operator approval.

### 18.3 Database Access

The Baanbaan SQLite database must be readable by the `baanbaan` OS user (no `sudo` required). Standard file permission `640` with owner `baanbaan:baanbaan` is sufficient. COSA connects via SSH as the `baanbaan` user and executes `sqlite3` in read-only mode.

---

## 19. Open Questions Resolution Log

All Phase 1 open questions are now resolved.

| # | Question | Resolution |
|---|---|---|
| 1 | Does Baanbaan expose `/health` and `/health/ready` endpoints? | **COSA defines the contract.** See §18.1 — Baanbaan must implement these endpoints. |
| 2 | Process supervisor: pm2 or systemd? | **systemd** confirmed. Service name: `baanbaan`. See §18.2. |
| 3 | IMAP IDLE support? | **Gmail IMAP** with App Password. Polling every 60s (no IDLE needed). See §6.1. |
| 4 | Dedicated email account or sub-inbox? | **Dedicated Gmail account** (e.g. `cosa.baanbaan@gmail.com`) configured by the operator. |
| 5 | SQLite accessible without sudo? | **Yes** — `baanbaan` user has direct read access. No privilege escalation needed. |

---

*Phase 1 spec complete. Phase 2 spec to follow after Phase 1 exit criteria are verified in staging.*
