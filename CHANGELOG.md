# Changelog

All notable changes to COSA are documented here.

Format: [Semantic Versioning](https://semver.org). Sections: **Added**, **Changed**, **Fixed**, **Security**, **Removed**.

---

## [1.0.4] — 2026-04-14

Four production bugs fixed (backup alert, ips_alert approval loop, orphaned approval silence, shift report crash) plus the credential-audit suppression workflow.

### Fixed

**Backup verification (`src/tools/backup-verify.js`)**
- Auto-detect glob hardcoded to `readings_*.jsonl` — verify kept finding the stale April 9 zero-byte file (created before the empty-table fix, no sidecar) every night and sending a "corrupt backup" alert. Glob is now `*.jsonl` so it finds the most recently modified backup file regardless of table name.

**IPS alert approval loop (`src/tools/ips-alert.js`)**
- `RISK_LEVEL` changed from `'medium'` to `'read'`. Security alerts from cron sessions were blocked behind operator approval before they could be sent — a chicken-and-egg design flaw. Security notifications are now auto-approved in all session types.

**Orphaned approval silently dropped (`src/approval-engine.js`)**
- When an operator replied to an approval email but the originating session was no longer in memory (process restart between request and reply), `processInboundReply` returned `'ambiguous'` without any feedback. The operator's reply now generates a "session gone" email explaining the action was not executed and the next scheduled run will re-request.
- `_localHour()` rewritten to use `Intl.DateTimeFormat` with `hourCycle: 'h23'` instead of `toLocaleString hour12: false` — the old form returns `"24"` at midnight on Node/WSL, permanently disabling quiet-hours suppression for overnight cron tasks.

**Shift report wrong appliance (`src/tools/shift-report.js`)**
- Tool was written for the WeatherStation mock (queried `temperature_c`, `humidity_pct`, `weather_description` from a `readings` table). Completely rewritten for the BaanBaan restaurant POS: now queries `orders` (counts by status), `payments` (revenue totals), `payment_errors` (error count), and `timesheets` (staff on shift) in parallel. Anomaly detection covers high payment errors, orders with no payments, and high cancellation rate. Returns zero counts rather than throwing when no activity exists.

**Appliance identity mismatch (`config/appliance.yaml`)**
- `appliance.name` updated from `"WeatherStation Dev Mock"` to `"Hanuman Thai Cafe"` — the old name propagated into the system prompt and all alert emails, causing the agent to reason about a weather station context.
- `backup_run.tables` restored to the BaanBaan table list (`orders`, `order_items`, `payments`, `payment_errors`, `merchants`, `menu_items`, `employees`, `timesheets`, `reservations`, `feedback`) after being incorrectly reverted to `[readings]`.

### Added

**Credential-audit finding suppression**
- `src/session-store.js` — `suppressed_findings` table with `createSuppression()`, `isSuppressionActive()`, and `listSuppressions()`. Suppressions are keyed by fingerprint (`pattern:file:line`) and support optional expiry.
- `src/tools/credential-audit.js` — Each finding now carries a `fingerprint` field. Active findings are filtered against both the DB suppression table and a static `tools.credential_audit.suppressed_findings` list in `appliance.yaml`. Returns `{ findings, suppressedFindings }` so the agent can distinguish new alerts from already-acknowledged ones.
- `src/email-gateway.js` — `SUPPRESS_RE` pattern and `_processSuppressReply()` handler. Operator can silence a recurring finding by replying to any IPS alert email with `SUPPRESS <fingerprint> [reason]`. Sends a confirmation email and persists the suppression to the DB.
- `src/cron-scheduler.js` — Credential-audit cron prompt updated to explain the suppression mechanism and instruct the agent to include a `SUPPRESS <fingerprint> <reason>` response option for each active finding in the IPS alert.

---

## [1.0.3] — 2026-04-09

Hotfixes from first production deployment against the Baanbaan POS appliance.

### Fixed

**Email gateway (`src/email-gateway.js`)**
- IMAP `since` filter now uses a 2-day lookback window instead of `BOOT_TIME` — `BOOT_TIME` as a day-granular IMAP date caused messages to be silently missed due to timezone offset disagreements between the Pi and Gmail's IMAP server. The per-message BOOT_TIME guard still prevents stale messages from being reprocessed.

**Health check tool (`src/tools/health-check.js`)**
- `http_check: false` in `appliance.yaml` now correctly suppresses HTTP checks — the flag was read from config but never applied; HTTP failures still drove `overall_status` to `unreachable` even when disabled
- Skipped HTTP checks now return `reachable: null` instead of `reachable: true` to prevent Claude from reporting them as "Reachable" in operator emails
- `SYSTEMCTL_CMD` replaced with `buildSystemctlCmd()` which reads `process_supervisor.service_name` from config at call time instead of hardcoding `baanbaan`

**Tool schema descriptions (`src/tools/`)**
- Removed hardcoded "WeatherStation" references from tool `description` fields in `backup-run.js`, `pause-appliance.js`, `restart-appliance.js`, `settings-write.js`, and `shift-report.js` — these strings are fed to Claude as context and were causing operator emails to refer to the appliance as "WeatherStation"

---

## [1.0.0] — 2026-04-08

Phase 2 & 3 — Full production release. Completes the tool suite (17 new tools including `pause_appliance`, `backup_verify`, and the full Phase 3 set), hardens every core subsystem, and ships the cron session timeout, dead-letter queue, watchers table, and per-installation credential isolation.

### Added

**New tools (Phase 2 & 3)**
- `backup_verify` — verifies backup integrity over SSH; integrated into cron with alert email on failure
- `pause_appliance` and 16 additional Phase 3 tools — full tool output shape alignment and audit persistence for all tool calls

**Session store (`src/session-store.js`)**
- `dead_letters` table — persists emails that triggered a dispatch error so they can be reviewed without loss
- `watchers` table — stores persistent monitoring rules (`id`, `code`, `trigger_count`, `last_alerted_at`, `enabled`)

**Cron scheduler (`src/cron-scheduler.js`)**
- 10-minute hard timeout (`CRON_SESSION_TIMEOUT_MS`) on all cron-triggered orchestrator sessions via `runSessionWithTimeout()`; prevents a hung tool call or approval wait from blocking subsequent scheduled tasks indefinitely
- `backup_verify`, archive check, shift report, weekly digest, git audit, and process monitor tasks all wrapped with the new timeout

**Security gate (`src/security-gate.js`)**
- IPv4 address sanitization pattern — redacts internal network topology from tool output before it reaches the LLM
- Unix path sanitization — strips absolute paths under `/home`, `/root`, `/etc`, `/var`, `/opt`, `/tmp`, `/proc`, `/sys`

**Email gateway (`src/email-gateway.js`)**
- Failed dispatch errors now saved to `dead_letters` via `saveDeadLetter()` — no inbound email is silently lost
- `_resetSmtpTransport()` exported for test isolation (allows verifying `createTransport` config per-test)

**Tests**
- `tests/context-compressor-guard.test.js` — isolated unit tests for the empty-middle-slice guard and role-alternation logic; runs on Win32 without `better-sqlite3`
- `tests/memory-manager.test.js` — unit tests for truncation passes 1–4 and `_applyPatch`; fully mocked fs and config

### Changed

**Orchestrator (`src/orchestrator.js`)**
- `MAX_TOKENS` raised from 4096 → 8192 to prevent security/compliance digests from being silently truncated mid-sentence
- `extractFinalText()` now concatenates all `text`-type content blocks instead of returning only the first, so multi-block responses are never partially dropped
- Dynamic risk resolution for `appliance_api_call`: the orchestrator resolves `'dynamic'` risk at call time from the endpoint's configured `risk` field (falls back to `'high'` for unknown endpoints)
- Approval request emails now include a richer `action_summary` — `appliance_api_call` requests show the endpoint name and caller-supplied `reason` field

**Approval engine (`src/approval-engine.js`)**
- `requestApproval()` catches email send failure and returns `{ approved: false }` immediately instead of hanging the session
- `_resolve` is now stored alongside FSM intents so `processInboundReply` and `_runExpiryCheck` can force-resolve the outer Promise if an FSM intent throws — prevents approval-limbo sessions
- Operator receives a feedback email when replying to a token that has already been approved, denied, or expired

**Context compressor (`src/context-compressor.js`)**
- Early-return guard: if `protectFirstN + protectLastN ≥ messages.length` there is nothing in the middle to summarise; returns the original array instead of calling Haiku with an empty payload
- Summary role is now computed to maintain the strict user/assistant alternation invariant required by the Anthropic API (`headLastRole` determines `summaryRole`)
- When middle turn count is even, a minimal bridge message (`[Context acknowledged]`) is injected at the summary→tail boundary to prevent consecutive same-role messages

**Memory manager (`src/memory-manager.js`)**
- Hard-slice in `_enforceLimit()` now appends `<!-- END MEMORY -->` so readers can detect a truncated document
- `_applyPatch()` extracted as a shared helper used by both `updateMemory()` and `makeMemoryAcceptor()` — patch logic now lives in a single place

**Session store (`src/session-store.js`)**
- `saveTurn()` SELECT + INSERT wrapped in a SQLite transaction — eliminates a race condition where concurrent email-triggered and cron-triggered sessions could produce duplicate `turn_index` values
- `searchTurns()` now catches FTS5 query syntax errors (unbalanced quotes, bare `AND`, etc.) and returns `[]` instead of throwing

**Email gateway (`src/email-gateway.js`)**
- DKIM check is now opt-out via `appliance.security.dkim_check: false` in `appliance.yaml` — enables non-Gmail providers (Outlook, custom domain) that do not inject `Authentication-Results` headers

**Tool registry (`src/tool-registry.js`)**
- `getRiskLevel()` logs a `console.warn` for unknown tool names before defaulting to `'read'`, making mis-named tools visible in logs before `dispatch()` throws `TOOL_NOT_FOUND`

### Fixed

**Credential store (`src/credential-store.js`)**
- Replaced static KDF salt (`cosa-credential-store-v1`) with a per-installation random 32-byte salt generated on first use and stored in the `_meta` table — two operators sharing the same `COSA_CREDENTIAL_KEY` no longer derive identical AES keys

**Security gate (`src/security-gate.js`)**
- Base64 secret pattern narrowed with a lookahead requiring at least one `+` or `/` character — eliminates false positives on 40-character hex strings (git SHAs, SHA-256 hashes)
- Tirith stdin guard: `child.stdin` is checked for existence before `.end(payload)` is called; if the pipe was not created the gate fails open with a warning instead of throwing

### Security

- Per-installation KDF salt in `credential-store.js` eliminates shared-key risk across multi-appliance deployments
- IPv4 address and Unix path sanitization in `security-gate.js` prevents internal topology leakage into LLM context
- Base64 pattern fix removes false-positive redaction of git SHAs in tool output

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

**Setup wizard (`setup.js`)**
- Interactive first-time setup: `npm run setup`
- Auto-discovers Baanbaan via `baanbaan.local` (mDNS) or manual IP entry
- Generates an ED25519 SSH key pair and registers it with Baanbaan using a 6-digit setup PIN
- Verifies SSH connectivity before proceeding
- Collects operator email, COSA Gmail address + App Password (with length validation), and Anthropic API key (live API verification)
- Operator mode selection (simple / advanced) with plain-language description
- Writes `.env`, `config/appliance.yaml`, and `config/APPLIANCE.md` automatically
- Runs a final health check against Baanbaan before declaring setup complete
- Uses only Node.js built-in modules — no extra dependencies

**Baanbaan setup API spec (`docs/baanbaan-setup-api-spec.md`)**
- Defines the three endpoints Baanbaan must implement: `GET /setup/info`, `POST /setup/register-ssh-key`, `GET /setup/status`
- PIN security model: 6-digit, 24-hour expiry, single-use
- `GET /setup/info` response shape (all fields COSA reads for auto-config)
- Error codes for `POST /setup/register-ssh-key`: `401` wrong PIN, `410` expired, `409` already registered, `503` setup inactive
- CLI commands: `baanbaan generate-setup-pin`, `baanbaan reset-cosa`
- mDNS/Avahi configuration for `baanbaan.local` auto-discovery
- Summary table of all required Baanbaan-side changes

**Weather Station mock appliance (`dev/tools/weather-station/`)**
- Local development appliance for testing COSA without a real Baanbaan device
- Implements the full Phase 1 protocol: health API (`/health`, `/health/ready`), setup API (`/setup/info`, `/setup/register-ssh-key`, `/setup/status`), SSH interface, and SQLite database
- Fetches live hourly weather readings from Open-Meteo (free, no API key) and stores them in `data/weather.db` — gives COSA real data to query during development
- SSH mock accepts only the specific command patterns COSA tools send; all other commands return exit code 127
- Generates an ED25519 SSH host key on first start and prints a 6-digit setup PIN + `appliance.yaml` config snippet
- Works with `npm run setup` (Option A) or manual `appliance.yaml` config (Option B)
- `npm run reset` clears all state (keys, PIN, database) for a clean restart
- Configured via `config/station.yaml` (location, HTTP port 3000, SSH port 2222)
- No extra dependencies beyond what COSA already uses; `data/` directory gitignored

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

- Upgraded `nodemailer` from `^6.9.0` to `^8.0.4` to fix three CVEs: SMTP command injection via unsanitized `envelope.size` (GHSA-c7w3-x93f-qmm8), address parser DoS via recursive calls (GHSA-rcmh-qjqh-p98v), and email routing to unintended domain (GHSA-mm7p-fcc7-pg87). API usage (`createTransport` + `sendMail` with plain-text STARTTLS) is unchanged.
- SQL passed via stdin to `sqlite3` process, eliminating shell injection surface (no SQL in command arguments)
- SSH host key fingerprint verification via `hostVerifier` callback; SHA-256 format matching OpenSSH `ssh-keygen -l -E sha256`
- `known_hosts_path` removed from `appliance.yaml` (field was never read; its presence created a false sense of security — actual protection is via `host_key_fingerprint`)
- `process` variable renamed to `procInfo` in `health-check.js` to eliminate accidental Node.js global shadowing
- Multi-statement SQL queries rejected (semicolons blocked) in `db_query` to prevent statement smuggling
- `PRAGMA` added to `db_query` destructive keyword blocklist

---

*Previous versions: none — this is the initial release.*
