# Changelog

All notable changes to COSA are documented here.

Format: [Semantic Versioning](https://semver.org). Sections: **Added**, **Changed**, **Fixed**, **Security**, **Removed**.

---

## [0.1.0] — 2026-03-29

Phase 1 — Foundation. Initial implementation of the COSA agent core, all three Phase 1 tools, and the full email-based operator interface.

### Added

**Core agent loop (`src/orchestrator.js`)**
- Claude Sonnet 4.6 agentic loop with 20-iteration cap
- Multi-turn conversation management
- Tool-use block processing and dispatch through security and approval gates
- Session lifecycle management (open → complete/error)

**Context builder (`src/context-builder.js`)**
- Layered system prompt assembly from COSA identity, `config/APPLIANCE.md`, enabled tool schemas, and current timestamp
- `APPLIANCE.md` cached at module load (read once, not per session)

**Session store (`src/session-store.js`)**
- SQLite persistence with WAL mode and FTS5 full-text search on conversation history
- Tables: `sessions`, `turns`, `turns_fts`, `tool_calls`, `approvals`, `alerts`
- Idempotent migration runner (safe to restart)

**Tool registry (`src/tool-registry.js`)**
- Tool registration, JSON Schema input validation via AJV, and handler dispatch
- Risk level classification: `read`, `medium`, `high`, `critical`
- Tool enable/disable via `appliance.yaml`

**Security gate (`src/security-gate.js`)**
- Pre-execution dangerous command detection (configurable regex patterns in `appliance.yaml`)
- Default blocked patterns: `rm -rf`, `DROP TABLE/DATABASE`, unscoped `DELETE`, `kill -9`, `systemctl stop/disable/mask`, raw disk operations, `chmod 777`, pipe-to-shell (`curl | bash`), credential exposure patterns
- Output sanitization: strips Anthropic API keys, passwords, and tokens from tool output before LLM sees it

**Approval engine (`src/approval-engine.js`)**
- Operator approval FSM: `pending` → `approved` / `denied` / `expired`
- One-time token generation: `APPROVE-XXXXXXXX` (32 bits entropy via `crypto.randomBytes`)
- Approval request emails with configurable timeout (default 30 min, urgent 5 min)
- Token verification and state transition on operator reply
- Background expiry sweep every 5 minutes
- All approvals, denials, notes, and expirations persisted to `approvals` table

**SSH backend (`src/ssh-backend.js`)**
- Persistent SSH connection to appliance with automatic reconnection
- Exponential backoff: 1 s → 2 s → 4 s → … → 30 s cap
- SHA-256 host key fingerprint verification (MITM protection)
- Security warning logged when `host_key_fingerprint` is not configured
- SQL and other arguments passed via stdin to remote process (not shell arguments) to prevent injection
- Per-command timeout enforcement

**Email gateway (`src/interfaces/email-gateway.js`)**
- IMAP polling every 60 seconds (imapflow)
- Operator address verification — unknown senders silently ignored
- Approval reply detection (`APPROVE-XXXXXXXX`, `DENY`)
- SMTP sending for query responses, approval requests/confirmations/denials/expirations, and cron alerts (nodemailer)
- Email threading via `In-Reply-To` and `References` headers

**Cron scheduler (`src/interfaces/cron-scheduler.js`)**
- Hourly health-check task (configurable expression: default `0 * * * *`)
- Alert generation when `overall_status` is `degraded` or `unreachable`
- Alert deduplication: no repeat alert within 60 minutes for the same category/severity

**Tools**
- `health_check` — SSH connectivity + HTTP `GET /health` + HTTP `GET /health/ready` + systemd `ActiveState`/`SubState`/`NRestarts` via SSH; classifies as `healthy`, `degraded`, or `unreachable`
- `db_query` — read-only `SELECT` over SSH via `sqlite3 -json -readonly`; validates query, enforces 100-row limit, prevents shell injection via stdin
- `db_integrity` — `PRAGMA integrity_check` and optional `PRAGMA wal_checkpoint(PASSIVE)` over SSH

**Operator communication modes**
- `COSA_OPERATOR_MODE=simple` (default) — plain business language; no technical jargon in emails; focuses on business impact
- `COSA_OPERATOR_MODE=advanced` — full technical detail in emails (HTTP status codes, systemd states, SSH connectivity, raw metrics); intended for technically savvy operators or developer-assisted troubleshooting
- Configured in `.env`; only affects outbound email content — behavior, security, and logging are identical in both modes

**Configuration**
- `config/appliance.yaml` — Baanbaan-specific adapter: SSH, API, database, operator, cron, tool flags, dangerous-command patterns
- `config/cosa.config.js` — Config loader with required-field validation
- `config/APPLIANCE.md` — Agent-readable appliance identity context

**Logging (`src/logger.js`)**
- Structured JSON logging (newline-delimited) to stdout
- Fields: `ts`, `level`, `module`, `msg` plus optional context
- Respects `COSA_LOG_LEVEL` environment variable

**Tests**
- 9 unit test suites covering all core modules
- 3 tool-specific test suites
- 8 end-to-end staging tests covering all Phase 1 functional scenarios (F1–F8)
- `npm run test:staging` script for sequential integration test execution

### Security

- SQL passed via stdin to `sqlite3` process, eliminating shell injection surface (no SQL in command arguments)
- SSH host key fingerprint verification via `hostVerifier` callback; SHA-256 format matching OpenSSH `ssh-keygen -l -E sha256`
- `known_hosts_path` removed from `appliance.yaml` (field was never read; its presence created a false sense of security — actual protection is via `host_key_fingerprint`)
- `process` variable renamed to `procInfo` in `health-check.js` to eliminate accidental Node.js global shadowing
- Multi-statement SQL queries rejected (semicolons blocked) in `db_query` to prevent statement smuggling
- `PRAGMA` added to `db_query` destructive keyword blocklist

---

*Previous versions: none — this is the initial release.*
