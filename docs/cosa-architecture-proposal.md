# COSA Architecture Proposal

**Version:** 0.2 (Revised after design review)
**Date:** 2026-03-28
**Branch:** architecture
**Status:** Proposal — not yet approved

---

## 1. Overview

COSA (Code-Operate-Secure Agent) is a persistent, autonomous agent that manages the full lifecycle of a software appliance: development, operations, and security. It runs headless, learns from every incident, and escalates to a human only when risk is too high to decide alone.

The first target appliance is **Baanbaan**, a POS relay for small restaurants running on ARM hardware with a Bun/SQLite/SAM stack.

This document proposes the architecture for COSA's first production version, informed by:
- The COSA functional specification (`docs/cosa_spec.md`)
- The Hermes Agent architecture report (`docs/hermes_architecture.md`)
- The Baanbaan appliance blueprint (`docs/appliance-architecture.md`)

---

## 2. Guiding Principles

| Principle | Implication |
|---|---|
| **Headless-first** | No human required for routine work. Human approval only for irreversible or high-impact actions. |
| **Appliance-agnostic core** | Everything except context files and tool adapters is reusable across appliances. |
| **Defense-in-depth** | Security is not a module — it runs at every layer. |
| **Closed learning loop** | Every incident that requires novel work must produce a skill. Skills improve on reuse. |
| **Minimal blast radius** | Read-only by default. Writes and deployments require explicit escalation. |
| **Formal state machines** | All multi-step agent workflows use FSM (mirroring SAM pattern in the appliance itself). |

---

## 3. System Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        COSA Agent Process                       │
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐   ┌────────────────────┐   │
│  │  Interfaces │    │  Core Agent  │   │   Tool Domains     │   │
│  │             │    │              │   │                    │   │
│  │ • Email     │──▶│  Orchestrat- │──▶│ CODE  OPERATE      │   │
│  │ • CLI       │    │  or Loop     │   │ SECURE             │   │
│  │ • Cron      │    │              │   │                    │   │
│  └─────────────┘    │  Memory &    │   └────────────────────┘   │
│                     │  State       │          │                 │
│                     └──────────────┘          │                 │
│                          │                    │                 │
└──────────────────────────┼────────────────────┼─────────────────┘
                           │                    │
              ┌────────────▼───────┐   ┌────────▼─────────────────┐
              │  COSA Datastores   │   │    Appliance (same LAN)  │
              │ • session.db       │   │ • SSH backend            │
              │ • skills.db        │   │ • Appliance APIs         │
              │ • memory.db        │   │ • Git repository         │
              │ • MEMORY.md        │   │ • SQLite                 │
              │ • APPLIANCE.md     │   │ • Process supervisor     │
              └────────────────────┘   └──────────────────────────┘
```

COSA and the appliance are **separate processes on separate devices, on the same LAN**. COSA never runs inside the appliance process. It communicates via SSH, the appliance's own HTTP API, and git.

---

## 4. Appliance-Agnostic Core vs. Appliance-Specific Layer

Keeping the core agent generic from the start avoids costly refactoring when a second appliance is onboarded.

```
┌─────────────────────────────────────────────────────────────┐
│                      COSA CORE (generic)                    │
│                                                             │
│  Orchestrator · Memory System · Approval Engine ·           │
│  Skill Library · Context Compression · Session DB ·         │
│  Security Pipeline (Tirith + dangerous-cmd detection) ·     │
│  Email Gateway · Cron Scheduler                             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│               APPLIANCE ADAPTER (per appliance)             │
│                                                             │
│  APPLIANCE.md  OPERATIONS.md  tool config  cron schedule    │
│  SSH connection string  API base URL  POS adapter hints     │
│  Cloudflare process name  Escalation contacts               │
└─────────────────────────────────────────────────────────────┘
```

The adapter is a directory of configuration + context files. Swapping appliances means swapping that directory. No core code changes.

---

## 5. Core Agent Loop

Adapted directly from Hermes's proven synchronous loop:

```
┌──────────────────────────────────────────────────────────────┐
│                        COSA Core Loop                        │
│                                                              │
│  1. Receive trigger (interface message, cron tick, alert)    │
│  2. Build layered prompt (see §7)                            │
│  3. Call Claude API → stream response                        │
│  4. Handle tool calls:                                       │
│       a. Security gate (Tirith scan + dangerous-cmd check)   │
│       b. Approval gate (if action requires human sign-off)   │
│       c. Execute tool                                        │
│       d. Log to session.db                                   │
│  5. If more tool calls → goto 4                              │
│  6. Final response → route to interface (email / CLI / log)  │
│  7. Post-turn: memory nudge, skill creation check            │
└──────────────────────────────────────────────────────────────┘
```

The loop is deliberately simple. Complexity lives in the tools, not the loop.

---

## 6. Three Domains and Their Tools

### 6.1 CODE Domain

Handles all modifications to the appliance codebase: bug fixes, feature additions, dependency updates, and deployment.

| Tool | Description | Risk Level |
|---|---|---|
| `git_status` | Working tree and branch state | Read |
| `git_log_audit` | Inspect recent commits | Read |
| `git_diff` | Show staged/unstaged changes | Read |
| `git_commit` | Commit staged changes | Medium |
| `git_push` | Push to remote | High → Approval |
| `bun_test` | Run test suite | Read |
| `bun_install` | Install/upgrade deps | Medium |
| `claude_code_spawn` | Spawn an isolated Claude Code CLI session via SSH for code edits, database repair, or complex multi-file operations | Medium |
| `code_review` | Spawn independent subagent reviewer (Nightwire pattern) | Read |
| `deploy` | pm2/systemd restart after successful test+review | High → Approval |
| `rollback` | Restore prior binary/commit | High → Approval |
| `dep_audit` | Check for CVEs in package.json | Read |

**Code workflow — Claude Code CLI spawning:**

COSA's primary instrument for complex work (code edits, database repair, multi-step investigations) is a sandboxed Claude Code CLI session launched via SSH into the appliance. This is the most powerful tool in the kit: Claude Code has access to the full filesystem on the appliance, can run tests, inspect logs, and perform surgical database repairs — the same way a skilled engineer would work over SSH.

This pattern is borrowed from Puffin's architecture of spawning Claude Code instances (proven to work very well for code modification tasks) and is directly comparable to Hermes's `delegate_task`, which spawns an isolated child AIAgent with its own conversation context, terminals, and tools.

**Hermes `delegate_task` vs. Claude Code CLI spawn — comparison:**

| Dimension | Hermes `delegate_task` | Claude Code CLI spawn (Puffin pattern) |
|---|---|---|
| Isolation | Separate AIAgent context; own terminal + tool access | Separate Claude Code process; direct SSH filesystem access |
| Scope | Any agent-level task (research, sub-operations) | Code and filesystem work specifically |
| Result | Summary returned to parent | git diff / changed files returned to COSA for review |
| Review step | Parent reviews summary | COSA reviews diff before staging — built-in review gate |
| Complex DB repair | Via terminal tool, LLM-guided | Native: Claude Code can query, repair, and verify in one session |
| State sharing | No shared state with parent | No shared state with COSA datastores (by policy) |

**Decision:** Use Claude Code CLI spawn (Puffin pattern) as the primary instrument for all appliance-side work — code, database, and complex operational tasks. The built-in diff review gate and the direct filesystem access make it better suited to the appliance context than Hermes's general-purpose subagent delegation, which we retain only for COSA-side tasks (e.g., independent code review by a separate reviewer agent).

Human approval is required before `git_push` or `deploy` on non-trivial changes. Low-risk changes (typos, config values, isolated utilities with >90% test coverage) may be auto-deployed after passing tests and the automated review step.

### 6.2 OPERATE Domain

Handles runtime operations: health, reporting, POS integration, scheduled tasks, alerts.

| Tool | Description | Risk Level |
|---|---|---|
| `health_check` | HTTP GET /health + /health/ready | Read |
| `db_query` | Read-only SQLite query (no writes) | Read |
| `db_integrity` | PRAGMA integrity_check + WAL status | Read |
| `order_status` | Query active orders, stuck SAM states | Read |
| `shift_report` | Aggregate daily sales summary | Read |
| `archive_search` | Query JSONL cold archives (off-hours gate enforced) | Read |
| `pos_health` | Check POS adapter connectivity | Read |
| `printer_status` | Receipt printer check | Read |
| `backup_run` | Trigger S3/JSONL backup | Medium |
| `backup_verify` | Verify checksum of last backup | Read |
| `cache_flush` | Clear appliance-level cache | Medium |
| `settings_write` | Update appliance_meta key-value | Medium → Approval |
| `restart_appliance` | pm2/systemd restart (graceful) | High → Approval |

**Complex operational repairs:** When a static tool is not sufficient (e.g., a stuck SAM workflow that cannot be resolved by a restart, a corrupted SQLite page, a misconfigured migration), COSA escalates to a `claude_code_spawn` session on the appliance. Within that session, Claude Code has the full context, can query the database, inspect the SAM state JSON, and perform a targeted repair — the same way an experienced engineer would diagnose it at the command line. All changes made in the session are reviewed by COSA before being committed.

**Operational continuity note:** COSA understands the appliance's SAM state machine semantics. When querying stuck or errored orders, it can identify which FSM state they are in (`pos_error`, `submitted_timeout`) and take the correct remediation path — retry, escalate to merchant, or cancel with notification. For structural repairs beyond what a retry can fix, Claude Code CLI is the repair tool.

### 6.3 SECURE Domain

Monitors, hardens, and actively defends the appliance against intrusion and misconfiguration.

| Tool | Description | Risk Level |
|---|---|---|
| `git_audit` | Check for unauthorized commits, force-push evidence | Read |
| `process_monitor` | List running processes, flag unknown PIDs | Read |
| `network_scan` | Enumerate active connections, flag unknown IPs | Read |
| `cloudflare_kill` | Kill the Cloudflare tunnel process | Critical — auto-permit policy TBD (see §18) |
| `pause_appliance` | Shut down the appliance service (not the machine) | Critical → Approval required |
| `pci_assessment` | Run PCI-DSS self-assessment checklist | Read |
| `credential_audit` | Check for exposed secrets in working tree | Read |
| `token_rotation_remind` | Alert operator that Clover/POS tokens are due for rotation | Read |
| `compliance_verify` | Validate config against known hardening baseline | Read |
| `jwt_secret_check` | Verify JWT secret entropy and rotation date | Read |
| `webhook_hmac_verify` | Re-verify that HMAC validation is active on POS webhook | Read |
| `access_log_scan` | Scan HTTP access logs for anomalies | Read |
| `ips_alert` | Send immediate escalation to operator email | Medium |

**Intrusion response escalation:**

```
Anomaly Detected
     │
     ▼
Is it a known false positive pattern? ──Yes──▶ Log and continue
     │ No
     ▼
Classify severity (Low / Medium / High / Critical)
     │
     ├─ Low:      Log + schedule follow-up audit
     │
     ├─ Medium:   Alert operator via email, await response window (15 min)
     │
     ├─ High:     Alert + kill Cloudflare tunnel,
     │            await operator approval for further action
     │
     └─ Critical: Kill Cloudflare + pause appliance,
                  alert operator immediately,
                  await manual restart approval
                  [auto-permit policy for Critical: TBD — see §18]
```

---

## 7. Layered Prompt Architecture

Mirrors Hermes's prompt caching strategy to achieve ~90% token discount on repeated context.

```
Layer 0  │ COSA core identity (static — cached indefinitely)
Layer 1  │ Current appliance identity: APPLIANCE.md (cached per session)
Layer 2  │ Learned operational patterns: OPERATIONS.md (cached per session)
Layer 3  │ Skill index: skills_list() compact index (~3k tokens)
Layer 4  │ MEMORY.md snapshot (loaded once at session start)
Layer 5  │ Active skill detail: skill_view(name) — loaded on demand
Layer 6  │ Tool registry (domain-filtered to relevant tools)
Layer 7  │ Session context summary (compressed middle turns)
Layer 8  │ Honcho memory recall (appended to user message, preserves cache)
Layer 9  │ Current message / cron trigger / alert payload
```

Layers 0–4 are frozen at session start and always cache-hit. Layers 5–9 change per turn. This structure keeps the per-turn cost low even for long operational sessions.

---

## 8. Memory Architecture

### 8.1 Local Persistent Memory (MEMORY.md)

Short-form, human-readable snapshot. Two files:
- **MEMORY.md** (~2200 chars max): Current appliance health state, recent incidents, active skills summary, operator preferences.
- **APPLIANCE.md**: Static appliance identity (runtime, DB path, POS type, Cloudflare process name, contact list, timezone, deploy path).

Updated in-place after each significant operation. Character limits are hard-enforced to prevent unbounded growth.

### 8.2 Cross-Session Episodic Memory (session.db)

SQLite with FTS5. Every turn, every tool call, every decision is logged. Enables:
- "What did we do last time the printer went offline?"
- "Has this error appeared before?"
- Audit trail for security incident review.

### 8.3 Skill Library (skills.db)

Procedural memory. Markdown documents in the agentskills.io format. Three levels:
- **Level 0:** `skills_list()` — compact index of all skills (~30 tokens/skill)
- **Level 1:** `skill_view(name)` — full skill document on demand
- **Level 2:** `skill_view(name, section)` — specific reference section

Skills are created from incidents. A skill is created when:
1. COSA resolved an incident that required more than 2 tool calls AND
2. No matching skill existed at the start of the resolution.

Skills self-improve: on reuse, COSA appends a `## Experience` section noting deviations, edge cases, and timing data.

**Seed skills for Baanbaan (Day 1):**
- `printer-offline-recovery`
- `stuck-order-recovery`
- `nightly-backup-verify`
- `pos-adapter-reconnect`
- `git-audit-clean`
- `cloudflare-tunnel-restart`
- `shift-report-generation`
- `emergency-pause-and-report`

### 8.4 Honcho AI-Native Memory (optional, Phase 5)

Unbounded, vector-embedded, cross-session operator modeling. Builds an evolving model of operator preferences and the appliance's behavioral patterns over time. Added in Phase 5 — not a dependency for initial launch.

---

## 9. Approval System

```
Tool call proposed
        │
        ▼
Is tool in AUTO_PERMIT list? ──Yes──▶ Execute
        │ No
        ▼
Is it a Critical security event? ──Yes──▶ Execute cloudflare_kill
        │                                  [pause_appliance requires approval]
        │ No                               [auto-permit policy: TBD — see §18]
        ▼
Look up approval policy for this tool:
  • once       → send token, wait for response, execute once, expire token
  • session    → approved for remainder of session after first approval
  • always     → persisted approval (operator previously set this)
  • deny       → blocked, explain why, suggest alternative
        │
        ▼
Approval pending → send email notification with:
  • What COSA wants to do
  • Why (brief reasoning)
  • What happens if denied
  • Approve token (reply code in email)
  • Auto-deny timeout (default: 30 min for non-urgent, 5 min for urgent)
        │
        ▼
Operator replies to email → verify token → execute → log outcome
```

All approvals, denials, timeouts, and emergency overrides are written to session.db with full context.

---

## 10. Security Architecture

### 10.1 Input Validation
- All incoming messages scanned for prompt injection patterns before reaching the core loop.
- Context files (APPLIANCE.md, OPERATIONS.md) scanned on load.
- No user-controlled content is interpolated directly into system prompt layers.

### 10.2 Tool Execution Gate (Tirith Pipeline)
Every tool call passes through:
1. **Dangerous command detection** — regex patterns for `rm -rf`, `DROP TABLE`, credential patterns, etc.
2. **Tirith binary scan** — checks for homograph URLs, shell injections, obfuscated payloads.
3. **Approval gate** — as described in §9.
4. **Execution** — tool runs in isolated context.
5. **Output sanitization** — credential patterns stripped from tool output before it enters the conversation.

### 10.3 Credential Management
- Credentials stored in encrypted store, never in MEMORY.md or session.db.
- Never passed to Claude Code sessions on the appliance.
- Audit check runs weekly: `credential_audit` verifies no secrets leaked into git working tree.

### 10.4 Code and Repair Isolation (Claude Code CLI)

Complex work on the appliance happens inside a Claude Code CLI session launched via SSH:
- Runs as a separate process with the appliance's own user context.
- No access to COSA's datastores (session.db, skills.db, MEMORY.md) — these live on the COSA Pi.
- Output reviewed by COSA before any git staging or deployment.
- Database repairs performed interactively: Claude Code queries, patches, and verifies the result in the same session, then COSA reviews the outcome.

This is the primary pattern for any work that requires judgment, filesystem access, or multi-step investigation on the appliance itself.

### 10.5 Appliance Defense Posture
Unique to the Baanbaan deployment context:
- **Cloudflare tunnel** is the appliance's public exposure vector. Killing it is the first line of defense.
- **SQLite defaults to read-only** for static tool queries (`db_query`, `db_integrity`). Complex writes go through a Claude Code session, which means they are LLM-reasoned, logged, and diffable.
- **POS adapter** has no write path from COSA — orders are placed by customers, not by COSA.
- **Network monitoring** flags any device not in the known-good inventory. COSA Pi and Baanbaan Pi are on the same LAN; unexpected MACs trigger an immediate alert.

---

## 11. Interfaces

### 11.1 Email Gateway (Primary Interface)

Email is the primary human-facing interface for Phase 1 (and likely beyond).

**Inbound (operator → COSA):** IMAP polling. The operator sends an email to COSA's address; COSA spawns a fresh agent session per message and replies.

**Outbound (COSA → operator):** SMTP send. COSA uses email for:
- Approval requests (inline reply code that COSA parses on the next IMAP poll)
- Proactive alerts: health degradation, security anomaly, failed backup, large error spike
- **Activity reports**: daily shift summary, weekly audit digest, monthly PCI report — all delivered as email without any operator request

This keeps the interface simple: the operator's inbox is the dashboard. No app to install, no webhook to configure.

Inbound email is processed by a stateless-per-message pattern (fresh agent per email, conversation persistence via session.db), identical to how Hermes's Gateway handles Telegram.

### 11.2 CLI
- Local terminal access on the COSA Pi.
- Full interactive conversation mode.
- Used during initial setup, debugging, and reviewing session history.

### 11.3 Cron Scheduler
- First-class scheduled agent tasks (not shell cron wrappers).
- Each cron task is a full agent invocation with its own tool access and session context.
- Schedule is defined in the appliance adapter config.

**Baanbaan default schedule:**

| Frequency | Task | Output |
|---|---|---|
| Every 1h | Health check (appliance + POS adapter + printer) | Alert email if anomaly |
| Every 6h | Git audit (unauthorized commits, force-push detection) | Alert email if anomaly |
| Every 6h | Access log scan (anomaly detection) | Alert email if anomaly |
| Every 6h | Process monitor (unknown PIDs) | Alert email if anomaly |
| Daily 3:00 AM | Backup to S3 + verify checksum | Alert email on failure |
| Daily 6:00 AM | Shift report (previous day) | Email report to operator |
| Daily 3:05 AM | Archive search integrity check | Alert email on failure |
| Weekly (Mon 2am) | Dependency audit (CVE scan) | Email digest |
| Weekly (Mon 2am) | Credential audit | Email digest |
| Weekly (Mon 2am) | Compliance verification | Email digest |
| Monthly (1st, 2am) | PCI self-assessment | Email report |
| Monthly (1st, 2am) | JWT secret rotation reminder | Email reminder |

---

## 12. Context Compression

Long operational sessions accumulate context. COSA protects:
- **First 3 turns** — always retained (captures initial problem framing).
- **Last 4 turns** — always retained (current reasoning state).
- **Middle turns** — summarized by a lightweight auxiliary model call when context approaches the limit.

The summary preserves: decisions made, tools called, outcomes, open questions. The raw session is never discarded — it remains in session.db for audit. Only the in-context representation is compressed.

---

## 13. Multi-Appliance Design

**Deferred.** The goal for Phase 1–5 is to get COSA working well on a single appliance (Baanbaan). The architecture is appliance-agnostic by design (§4), so onboarding a second appliance will mean creating a new adapter directory — no core changes required.

A shared skill library and cross-appliance orchestration are intentionally out of scope until COSA has proven its value on one appliance. The right governance model for skill promotion will be clearer once we have real operational experience to draw from.

---

## 14. Runtime Deployment

**Chosen: Dedicated Raspberry Pi on the same LAN as Baanbaan.**

A second Pi running COSA sits on the same local network as the Baanbaan Pi. COSA connects to Baanbaan via local SSH (no public network hop). This arrangement:
- Keeps LLM compute (network-bound, not CPU-bound) separate from POS compute
- Enables fast SSH access for `claude_code_spawn` sessions
- Avoids internet-routed SSH for sensitive operations (appliance DB, process management)
- Keeps data residency local
- Is cheap — a Pi is a one-time cost with no monthly fee

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
│          └── Email (SMTP/IMAP) ──▶ Internet │
│                                              │
└──────────────────────────────────────────────┘
```

COSA Pi outbound: email only (SMTP send, IMAP poll) and Claude API calls. No inbound ports required. This is intentionally minimal surface.

---

## 15. Technology Stack

| Component | Choice | Rationale |
|---|---|---|
| Agent runtime | Node.js / Bun | Matches appliance runtime; reuse tooling knowledge |
| LLM | Claude (claude-sonnet-4-6 default, claude-opus-4-6 for high-stakes) | Anthropic SDK; prompt caching for cost efficiency |
| Session/memory DB | SQLite (WAL + FTS5) | Matches appliance; zero config; proven in Hermes |
| Skill storage | Markdown files + SQLite FTS5 index | Human-readable; agentskills.io compatible |
| Security scanner | Tirith (Rust binary) | Pre-exec, fast, handles obfuscated payloads |
| Complex work on appliance | Claude Code CLI via SSH (Puffin pattern) | Proven for code edits, DB repair, multi-step investigation |
| Independent code review | Hermes `delegate_task` subagent | Isolated reviewer agent, no shared state with author |
| Email gateway | SMTP send + IMAP poll | No external service dependency; works with any email provider |
| Cron | Built-in scheduler (Hermes pattern) | Full agent invocation per tick, not shell cron |

---

## 16. Implementation Roadmap

### Phase 1 — Foundation (Weeks 1–2)
- [ ] COSA core loop (orchestrator, tool registry, session.db)
- [ ] SSH backend to Baanbaan (local network)
- [ ] Email gateway (IMAP poll + SMTP send) — both queries and activity reports
- [ ] APPLIANCE.md and OPERATIONS.md seed content for Baanbaan
- [ ] `health_check`, `db_query`, `db_integrity` tools
- [ ] Cron scheduler (1h health check only)
- [ ] Approval system via email (once/session/always/deny)
- [ ] Dangerous command detection

**Exit criteria:** COSA can answer "is Baanbaan healthy?" autonomously, alert the operator by email if not, and accept email replies as approval tokens.

### Phase 2 — Operate (Weeks 3–6)
- [ ] Full OPERATE tool set
- [ ] MEMORY.md local memory (load + update)
- [ ] session.db with FTS5 cross-session search
- [ ] Context compression
- [ ] Full cron schedule (backup, reports, archive check)
- [ ] Email activity reports (daily shift report, weekly digest)
- [ ] Skill library seed (8 Baanbaan seed skills)
- [ ] Skill creation workflow (post-incident)
- [ ] Layered prompt architecture with caching

**Exit criteria:** COSA runs the nightly backup, produces daily shift reports delivered by email, and creates skills from novel incidents — all without human intervention.

### Phase 3 — Secure (Weeks 7–12)
- [ ] Tirith integration
- [ ] Full SECURE tool set
- [ ] Intrusion escalation FSM (`cloudflare_kill`, `pause_appliance`)
- [ ] Credential management (encrypted store)
- [ ] Git audit cron
- [ ] Network monitoring (flag unknown MACs on local LAN)
- [ ] PCI assessment tool
- [ ] Access log anomaly scanning

**Exit criteria:** COSA detects a simulated intrusion (unauthorized SSH login), kills the Cloudflare tunnel, and pages the operator by email with full incident context.

**Note:** The auto-permit policy for `cloudflare_kill` in Critical mode is deferred (see §18). Phase 3 implementation will use the standard approval flow; the auto-permit exception can be added once we have real operational data on false positive rates.

### Phase 4 — Code (Weeks 13–20)
- [ ] `claude_code_spawn` tool (SSH session to appliance running Claude Code CLI)
- [ ] Independent subagent code review (Hermes `delegate_task` pattern)
- [ ] Deploy pipeline (spawn → test → review → approval → deploy → health verify → rollback on failure)
- [ ] Low-risk auto-deploy (config values, isolated utilities, >90% test coverage)
- [ ] Dependency audit + auto-update for patch-level CVEs
- [ ] Rollback tool
- [ ] Database repair via Claude Code CLI (no static tool needed)

**Exit criteria:** COSA autonomously fixes a known low-risk bug (with tests), passes review, deploys, and verifies health — with a human approval gate at the deployment step.

### Phase 5 — Evolve (Ongoing)
- [ ] Honcho AI-native memory integration
- [ ] Skill self-improvement pipeline (GEPA/DSPy)
- [ ] COSA self-documentation (auto-update OPERATIONS.md from session learnings)
- [ ] Multi-appliance design (revisit when Baanbaan is stable)

---

## 17. Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Wrong autonomous decision (e.g., killing Cloudflare on a false positive) | All emergency actions logged immediately; operator alerted by email with full context; manual restart is one email reply away |
| Credential exposure via tool output | Output sanitization pipeline strips known secret patterns before they enter conversation context |
| Confusion loop (COSA retries a failing action indefinitely) | Max retry count per tool per session (configurable, default 3); escalate to operator after limit |
| Stale skills leading to wrong procedure | Skill reuse logged; skills with >2 failures in last 30 days are flagged for review; skill success rate tracked |
| COSA Pi itself being compromised | COSA has no inbound ports; only outbound SMTP/IMAP and Claude API; SSH is outbound-only to Baanbaan Pi |
| Excessive API cost | Layered prompt caching; auxiliary model for compression; low-cost model for read-only queries; high-cost model only for decisions |
| `claude_code_spawn` session left open / runaway | Session timeout enforced by COSA (configurable, default 10 min); all sessions logged; operator alerted on abnormal exit |

---

## 18. Open Questions

The following questions remain open and should be decided before the relevant phase begins.

**1. Cloudflare kill auto-permit threshold** *(must resolve before Phase 3)*

Should `cloudflare_kill` on a Critical severity event be auto-permitted (no human approval needed), or should it require a short approval window (e.g., 5 minutes)?

- **Auto-permit argument:** Intrusion response needs to be faster than an email round-trip. A 5-minute window is meaningless if the operator is asleep.
- **Approval argument:** A false positive kills the POS tunnel during dinner service. That is a significant operational hit.
- **Data we need:** false positive rate from the anomaly classifier, estimated time-to-damage for a real intrusion. We don't have this yet.

*Deferral rationale:* Phase 3 is 7–12 weeks away. The right answer depends on real operational data from Phases 1–2. Implement with approval required initially; revisit after 4 weeks of Phase 3 operation.

---

*This proposal is a working draft. Review comments should be added below this line.*

<!-- review comments -->
