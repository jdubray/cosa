# COSA: Code-Operate-Secure Agent
## Functional and Technical Specification

---

## 1. Executive Summary

COSA (Code-Operate-Secure Agent) is a headless autonomous agent framework designed to manage the complete lifecycle of point-of-sale and similar appliance applications. COSA continuously monitors, maintains, secures, and evolves the appliance it manages, operating as a persistent learning agent that improves its capabilities over time.

Key design principles:
- **Headless and persistent** — runs unattended, makes autonomous decisions within defined guardrails
- **Learning system** — creates and refines operational procedures ("skills") from each incident it resolves
- **Human-in-the-loop for critical decisions** — dangerous operations require explicit approval via communication channels
- **Generic foundation, appliance-specific behavior** — the orchestration framework is appliance-agnostic; context files and skills are customized per deployment
- **Zero-trust security** — operates under a defense-in-depth security model with multiple independent verification layers

Target user: a merchant who wants their POS system to self-maintain, self-protect, and self-improve without requiring ongoing technical expertise.

---

## 2. Functional Requirements

### 2.1 Core Capabilities

COSA operates across three interrelated capability domains:

#### CODE: Development and Deployment
- Autonomously apply bug fixes to the appliance codebase
- Add minor features or UX improvements
- Update dependencies and libraries
- Run test suites to validate changes
- Deploy code changes to the appliance
- Perform independent code review of its own changes via delegated subagent

#### OPERATE: Runtime Management
- Monitor appliance health (connectivity, performance, dependencies)
- Generate operational reports (shift summaries, sales analytics, inventory status)
- Manage routine operational tasks (backups, log rotation, database maintenance)
- Interface with external systems (payment processors, printing services, cloud storage)
- Respond to operational alerts and resolve common failures
- Execute scheduled operational procedures (reconciliation, compliance scans)

#### SECURE: Security and Compliance
- Audit code repository for unauthorized changes
- Monitor for unexpected processes, network devices, and file changes
- Verify compliance requirements (PCI-DSS, SAQ-A, GDPR, etc.)
- Scan logs for security incidents and anomalies
- Perform integrity checks on critical data
- Alert on suspicious activities in real-time
- Manage credential rotation and access control

### 2.2 User Interactions

COSA exposes multiple interfaces for human operators:

**Email + WPA Gateway**
- Email sends authentication token that spawns a secure session in the Web Progressive App
- Real-time status queries in WPA ("What were today's sales?")
- Incident alerts pushed to WPA with auto-refresh
- Approval requests with token-gated decision UI
- Manual commands via WPA interface
- Push notifications for critical incidents
- Session-based access: expires after 24 hours or inactivity timeout

**CLI Interface**
- Local terminal access on the appliance device
- Interactive conversation with the agent
- Direct tool execution for debugging

**Scheduled Tasks (Cron)**
- Autonomous execution on a timer
- Results delivered to configured notification channels
- No human interaction required for routine operations

### 2.3 System Behavior

**Autonomous Mode**
- Executes health checks without user interaction
- Handles routine operational tasks (backups, log cleanup)
- Alerts users on critical issues
- Applies low-risk fixes automatically (e.g., restarting a failed service)

**Approval-Required Mode**
- Dangerous operations (code changes, database writes, service restarts)
- Anything affecting production state or data
- Operations affecting payment processing or customer data
- User has 24 hours to approve; otherwise request expires

**Learning Mode**
- Creates procedural skills from incident resolution
- Refines existing skills based on success/failure patterns
- Builds operational knowledge base over time
- Shares insights across similar appliances in same deployment

---

## 3. Technical Architecture

### 3.1 Core Design Pattern

COSA is based on Hermes Agent's proven orchestration model, with integration of Claude Code instances (Puffin pattern) for safe code modifications:

```
┌──────────────────────────────────────────────────┐
│            INTERFACES                            │
│ Email+WPA │ CLI │ Cron │ Webhooks │ Puffin      │
└────────────────────┬───────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   COSA Agent Core   │
          │ (Orchestration Loop)│
          └──────────┬──────────┘
                     │
   ┌─────────────────┼─────────────────┐
   │                 │                 │
┌──▼──┐         ┌──▼──┐         ┌──▼──┐
│CODE │         │OP.  │         │ SECURE
│TOOLS│         │TOOLS│         │TOOLS  │
└─────┘         └─────┘         └───────┘
   │                 │                 │
   └─────────────────┼─────────────────┘
                     │
         ┌───────────▼───────────┐
         │  COSA (Home Device)   │
         │   or Companion VPS    │
         │   SSH Backend to      │
         │   Appliance Network   │
         └───────────┬───────────┘
                     │ (SSH to appliance)
                     │
         ┌───────────▼───────────┐
         │   Appliance (Pi)      │
         │   Bun + SQLite        │
         │                       │
         │ Phones home to COSA   │
         │ Receives auth tokens  │
         │ (delivered via email) │
         └───────────────────────┘
```

The core loop is intentionally simple and synchronous:

```
while iteration_count < max_iterations:
    response = llm.chat.completions(
        model=model,
        messages=conversation_history,
        tools=available_tools,
        system_prompt=build_prompt()
    )
    if response.has_tool_calls:
        for call in response.tool_calls:
            result = execute_tool(call.name, call.args)
            conversation_history.append(tool_result(result))
    else:
        return response.content
```

Complexity lives in the subsystems surrounding the loop, not the loop itself.

### 3.2 System Components

#### Persistent State Management (SQLite)
- **session.db** — conversation history, tool execution logs, approval records
- **skills.db** — procedural skills library with metadata (success rate, last used, versions)
- **memory.db** — episodic memory (cross-session searchable index of incidents and resolutions)

All databases use FTS5 (full-text search) for semantic recall across sessions.

#### Memory Systems

**Local Persistent Memory** (~2-3 KB, curated by agent)
- APPLIANCE.md: Current system state (versions, configuration, network info, credentials store references)
- OPERATIONS.md: Learned operational patterns (peak hours, common failure modes, recovery procedures)

**Cross-Session Memory** (unbounded, searchable)
- Episodic: searchable index of all incidents, resolutions, and outcomes
- Semantic: vector embeddings of operational knowledge for relevance ranking
- Procedural: full-text indexed skills library

#### Layered System Prompt

COSA builds its system prompt from stable, cacheable layers:

1. Core identity ("You are COSA...")
2. Tool awareness and constraints
3. Frozen APPLIANCE.md snapshot (loaded once at session start)
4. Frozen OPERATIONS.md snapshot
5. Compact skills index (~3-5 KB for all available skills)
6. Context files (SECURITY.md, MONITORING.md, .cosarules)
7. Current date/time
8. Conversation history
9. Current user message

This design preserves Anthropic prompt caching (90% token discount on cached layers).

#### Tool Registry

Tools self-register via decorator pattern and are organized into logical groups:

**CODE Tools**
- git_commit, git_push, git_log_audit
- test_runner (run test suite)
- diff_review (delegated independent review)
- deploy (restart appliance service)
- dependency_scanner (npm/pip/bun audit)

**OPERATE Tools**
- appliance_health_check
- appliance_query (read-only database/API access)
- backup_manager
- report_generator
- log_analyzer
- external_api_client (payment processor, printers, cloud storage)

**SECURE Tools**
- git_audit (unauthorized commits)
- process_monitor (unexpected services)
- network_monitor (unexpected devices)
- file_integrity_check
- compliance_checker
- log_anomaly_detector

Each tool exposes a JSON schema, descriptions, and safety constraints.

#### Approval System

Dangerous operations trigger approval workflows:

1. **Detection** — regex patterns and Tirith pre-exec scanning identify risky commands
2. **Escalation** — COSA sends approval request via email with authentication token
3. **Token Generation** — secure session token created, valid for 24 hours or until WPA closes/idles
4. **User decision** — operator approves/denies via WPA with optional scope (once, session, always)
5. **Session Management** — WPA session auto-terminates after 24 hours or 30 minutes of inactivity
6. **Audit log** — all approvals recorded in session.db

Approval modes:
- **once** — approve this specific command only (expires with WPA session)
- **session** — approve this pattern for current WPA session
- **always** — permanently allowlist this pattern (stored securely, not in WPA state)
- **deny** — block execution and revoke token

#### Context Compression

When conversation approaches 50% of context window:
1. Protect first 3 and last 4 turns (recent context)
2. Summarize middle section via auxiliary model call
3. Preserve tool call/result lineage
4. Create session continuity with parent_session_id

#### Puffin/Claude Code Integration

For code modifications and independent review:
- COSA spawns a Puffin/Claude Code instance (separate LLM context and terminal)
- Puffin operates in an isolated Bun environment on the appliance or companion device
- Puffin drafts changes, runs tests, and generates comprehensive diffs
- COSA reviews Puffin's findings and risk assessment
- Approval sent to operator via email + WPA token
- Upon approval, Puffin executes deploy (git push, pm2/systemd restart)
- Session logs stored in both COSA and Puffin contexts for audit

This ensures independent verification of code changes without embedding execution logic in COSA itself.

### 3.3 Data Flow

**Health Check Cycle (Automated)**
```
CRON TRIGGER (e.g., every 1 hour)
  │
  ├─→ COSA queries appliance state (API/database/process list)
  │
  ├─→ COSA cross-references against expected baseline
  │
  ├─→ If all nominal:
  │     └─→ Log success to session.db
  │     └─→ No notification
  │
  └─→ If anomaly detected:
        ├─→ Classify severity (info, warning, critical)
        ├─→ Check episodic memory: has this happened before?
        ├─→ If yes: apply learned recovery procedure
        ├─→ If no: alert user via Telegram + log to session.db
        └─→ Create incident skill if resolution is novel
```

**Code Change Cycle (Approval-Required)**
```
USER REQUEST or AUTOMATED DETECTION
  │
  ├─→ COSA analyzes scope (files affected, test coverage, risk)
  │
  ├─→ COSA spawns Puffin/Claude Code instance
  │     ├─→ Isolated environment for code drafting
  │     ├─→ Run test suite in Puffin context
  │     └─→ Generate diff + risk assessment
  │
  ├─→ COSA compiles review results
  │
  ├─→ SEND APPROVAL REQUEST (email)
  │     ├─→ Summary of change + diff link
  │     ├─→ Review findings
  │     ├─→ Test results
  │     ├─→ Risk level
  │     └─→ Authentication token for WPA decision
  │
  ├─→ USER APPROVES/DENIES (via WPA)
  │
  ├─→ If approved:
  │     ├─→ Record approval in audit log
  │     ├─→ Puffin pushes changes to appliance repo
  │     ├─→ Deploy via Bun + pm2/systemd
  │     ├─→ Monitor appliance health post-deploy
  │     └─→ Log outcome to skills.db
  │
  └─→ If denied:
        └─→ Discard Puffin instance + log rejection reason
```

**Skill Creation**
```
INCIDENT RESOLVED
  │
  ├─→ COSA extracts decision sequence
  │     └─→ What did I check? What did I try? What worked?
  │
  ├─→ COSA abstracts to generic procedure
  │     └─→ Replace BaanBaan-specific values with variables
  │
  ├─→ COSA writes SKILL.md with:
  │     ├─→ Trigger conditions (when to use)
  │     ├─→ Prerequisites (what must be true first)
  │     ├─→ Steps (ordered procedure)
  │     ├─→ Rollback (how to undo if it fails)
  │     ├─→ Success criteria (how to know it worked)
  │     └─→ Metadata (creation date, success rate, appliances)
  │
  └─→ Skill indexed in skills.db for future retrieval
```

---

## 4. Security Model

COSA operates with defense-in-depth security:

### 4.1 Input Validation
- User messages validated for prompt injection attacks (regex + semantic scanning)
- Context files (APPLIANCE.md, OPERATIONS.md, .cosarules) scanned before inclusion in prompt
- All external API responses validated against expected schema

### 4.2 Tool Execution
- **Dangerous command detection** (regex patterns in tools/approval.py)
  - Recursive delete operations (rm -rf, unlink patterns)
  - Service stop/start (systemctl, systemd, killall)
  - Disk operations (mount, umount, dd)
  - Credential exposure (env variable dumps, log output to public channels)

- **Pre-exec security scanning** (Tirith binary)
  - Content-level threat detection (homograph URLs, shell injections, obfuscated payloads)
  - Automatic installation to ~/.cosa/bin/tirith

- **Approval workflow** (already described above)
  - All dangerous operations require explicit user approval
  - Approvals recorded and audit-logged

#### Environment Isolation
- Code execution tools run in isolated Bun processes or via Puffin/Claude Code instances
- Appliance Pi remains isolated from code sandbox via SSH backend
- Puffin instances handle code changes in separate Claude Code environments (not local execution)
- API keys and credentials stripped from subprocess environment
- Only safe env vars passed: PATH, HOME, USER, LANG, TERM, SHELL, TMPDIR

### 4.4 Data Access Control
- **Database access defaults to read-only** (SQLite WAL mode with read-only flag)
- Write operations via explicit write_database tool requiring approval
- Clover API access is read-only (health checks, balance verification, no payment initiation)
- PII redaction in logs (optional privacy.redact_pii mode)

### 4.5 Audit and Logging
- All tool executions logged to session.db
- All approvals recorded with timestamp, user, and scope
- All code deployments linked to git commits
- Incident outcomes tracked for skill improvement
- Long-term audit trail searchable via episodic memory

### 4.6 Credential Management
- Credentials stored in encrypted credential store (not in code, configs, or memory.db)
- COSA never outputs credentials
- Credentials referenced by symbolic name in tools
- Credential rotation reminders generated autonomously
- Lost/compromised credential procedures documented in SECURITY.md

---

## 5. Generic Design for Multi-Appliance Deployment

### 5.1 Appliance-Agnostic Framework

The COSA core loop, memory systems, security model, and approval workflows are completely generic. They don't know or care what appliance they're managing. Code execution is delegated to Puffin/Claude Code instances, not embedded in COSA.

Appliance-specific behavior comes from:

**Context Files (Customized per Appliance)**
```
APPLIANCE.md
├─ Runtime: (Bun on Raspberry Pi, Node.js on VPS, Docker container, etc.)
├─ Database: (SQLite, PostgreSQL, MongoDB, etc.)
├─ Dependencies: (npm, pip, cargo, apt, etc.)
├─ Deployment: (git pull + pm2, docker build + push, systemd, etc.)
├─ External APIs: (payment processors, printing, cloud sync, etc.)
└─ Network topology: (local networks, VPN, cloud endpoints)

OPERATIONS.md
├─ Peak hours (when the appliance is under heaviest load)
├─ Common failure modes and recovery procedures
├─ Expected uptime/reliability metrics
├─ Routine maintenance windows
├─ Data backup/recovery procedures
└─ Compliance requirements (PCI-DSS, GDPR, industry-specific)
```

**Tool Configuration (Customized per Appliance)**

Each tool has an appliance-specific configuration file:
```
tools/
├─ git_tools.yaml (repository URL, branch strategy, default remote)
├─ database_tools.yaml (connection string, schema, read-only vs write permissions)
├─ backup_tools.yaml (target storage, retention policy, verification procedure)
├─ api_tools.yaml (endpoints, authentication, rate limits)
├─ monitoring_tools.yaml (metrics to collect, alert thresholds, healthy baseline)
└─ compliance_tools.yaml (standards to audit, checklist items, evidence collection)
```

**Skills Library (Grows Over Time)**

Initially populated with generic skills from NousResearch's public skills repository:
```
skills/
├─ health-check (generic template)
├─ backup-and-verify (generic template)
├─ restart-service (generic template)
├─ dependency-audit (generic template)
└─ [appliance-specific skills created during operation]
```

### 5.2 Multi-Appliance Orchestration

For deployments managing multiple appliances (e.g., 10 BaanBaan POS locations):

**Separate Agent Instance per Appliance**
- Each appliance has its own COSA agent
- Each has separate session.db, skills.db, memory.db
- Operator receives approval emails for each appliance instance

**Shared Skill Library** (Optional)
- Successful skills from one appliance location automatically indexed for others
- Encourages cross-location learning (if location A solves a problem, location B can benefit)
- Requires skill to be generic enough to apply across locations

**Centralized Oversight** (Optional)
- Super-agent monitors all appliance agents
- Alerts on patterns across locations (e.g., "All 5 BaanBaan locations had payment processor issues this morning")
- Coordinates major updates across fleet

---

## 6. Operational Procedures

### 6.1 Initial Setup

1. **Deploy COSA**
   - Install Hermes Agent framework on Pi or companion VPS
   - Configure SSH backend if using companion device
   - Set up email gateway with SMTP credentials
   - Deploy Puffin/Claude Code instance (on same device or companion)

2. **Configure Appliance Context**
   - Create APPLIANCE.md with system state
   - Create OPERATIONS.md with known procedures
   - Create SECURITY.md with compliance and threat model

3. **Initialize Tools**
   - Configure tool connection strings, API keys, endpoints
   - Set safe defaults for each tool
   - Test connectivity to external systems

4. **Set Up Cron Schedule**
   - Health check: every 1 hour
   - Backup: daily at 3 AM
   - Reports: daily at 6 AM
   - Audits: weekly
   - Compliance scans: monthly

### 6.2 Ongoing Operation

**Daily Operator Tasks**
- Review morning report from COSA (email summary)
- Address any alerts from overnight
- Check email for approval requests, approve via WPA
- Monitor WPA dashboard for real-time anomalies

**Weekly Tasks**
- Review skill library (newly created or improved)
- Review security audit results
- Check dependency updates and plan merges

**Monthly Tasks**
- Full compliance assessment
- Review and clean old session logs
- Update OPERATIONS.md based on learned patterns
- Plan any major system upgrades

### 6.3 Incident Response

1. **Automated Detection** — COSA identifies issue
2. **Classification** — COSA assigns severity and category
3. **Skill Lookup** — COSA searches memory for similar incidents
4. **Resolution Attempt** — COSA applies learned procedure (if exists)
5. **User Alert** — If automated resolution fails, alert operator
6. **Approval Loop** — Operator approves next steps if needed
7. **Execution** — COSA executes approved remedy
8. **Skill Creation** — If novel, COSA creates/updates skill
9. **Notification** — COSA reports outcome to operator

### 6.4 Maintenance Windows

Planned maintenance (major updates, system upgrades):

1. Operator informs COSA: "Maintenance window: Saturday 2-3 AM" (via email or CLI)
2. COSA disables health check alerts for that window
3. Operator or Puffin instance performs maintenance
4. COSA verifies system health post-maintenance
5. COSA resumes normal monitoring

---

## 7. Integration Points

### 7.1 External Systems (BaanBaan Example, Generalizable)

**Payment Processor** (e.g., Clover API)
- Health check: verify connectivity and token validity
- Monitoring: sales total, transaction count, failure rate
- Alerts: timeout, authentication failure, rate limiting
- No autonomous payment initiation

**Printing Services** (e.g., Star TSP100III)
- Health check: printer online, ink/paper status
- Recovery: restart print queue, reset printer
- Alerts: offline, jam, paper out, error codes

**Cloud Backup** (e.g., S3)
- Automated backups on schedule
- Backup verification (periodic restore test)
- Cleanup old backups per retention policy
- Alerts: backup failure, restore failure

**Analytics/Dashboard** (e.g., Clover Dashboard)
- Pull sales data for reports
- Pull inventory for reconciliation
- Pull staff performance metrics
- Read-only access; no autonomous posting

### 7.2 Internal Appliance APIs

Assuming appliance exposes a REST/GraphQL API:

**Query Endpoints** (COSA can call anytime)
- GET /health → uptime, memory, CPU, disk
- GET /database/stats → row counts, database size
- GET /config → current settings, versions
- GET /logs → system logs for analysis

**Write Endpoints** (COSA requires approval)
- POST /settings/update → change configuration
- POST /database/backup → trigger manual backup
- POST /cache/clear → flush caches
- POST /restart → restart service

---

## 8. Implementation Roadmap

### Phase 1: Foundation (Week 1)
**Deliverables:**
- Hermes Agent installed and configured
- SSH backend (if using companion device) operational
- Email gateway + WPA interface working
- Puffin/Claude Code instance deployed
- APPLIANCE.md and OPERATIONS.md created
- Basic health check tool functional

**Success Criteria:**
- COSA reports appliance status on request
- Telegram integration tested
- No false alarms

### Phase 2: Operate (Weeks 2-4)
**Deliverables:**
- Cron schedule configured (health, backups, reports)
- Backup tool tested and verified
- Report generator producing daily summaries
- Memory system initialized and searched

**Success Criteria:**
- Daily reports received reliably
- Backups created and verified
- COSA successfully recalls past incidents
- Skills library growing organically

Phase 3: Secure (Weeks 3-6)

Enable Tirith scanning
Set up git audit cron
Implement network monitoring skill
Configure WPA-based approval policies for destructive operations
Run first PCI self-assessment via COSA
- Tirith pre-exec scanning installed

**Success Criteria:**
- No unauthorized commits detected
- Alerts on unexpected processes/devices
- Approvals working for high-risk operations
- Audit trail complete and queryable

Phase 4: Code (Weeks 4-8)

Enable Puffin integration for code modifications
Start with low-risk tasks: dependency updates, formatting fixes
Graduate to bug fixes with test coverage
Build the Puffin deploy pipeline (draft → test → approval → git push → pm2 restart)
- Deploy pipeline tested (Puffin git push → systemd)

**Success Criteria:**
- Low-risk changes (formatting, deps) require single-click approval
- Medium-risk changes (bug fixes) require approval + review
- High-risk changes (logic, schema) require email approval + WPA confirmation
- All deployments trackable to git commits and Puffin logs

### Phase 5: Evolve (Ongoing)
**Deliverables:**
- Self-improvement pipeline
- Multi-appliance skill sharing (if applicable)
- Honcho cross-session user modeling
- COSA operational documentation auto-generated

**Success Criteria:**
- COSA proactively suggests improvements
- Skill success rate improving over time
- Operator workload decreasing
- COSA becomes operational system documentation

---

## 9. Success Metrics

**Code Quality**
- Defect detection latency (time from bug introduction to detection)
- Defect remediation rate (% of bugs fixed autonomously)
- Code review turnaround (time from fix to deployment)
- Test coverage maintained or improved

**Operational Reliability**
- Appliance uptime (% of monitoring intervals healthy)
- MTTR (mean time to recovery) vs. before COSA
- False alarm rate (false positives in alerting)
- Backup verification success rate (% of backups restorable)

**Security**
- Incident detection latency (time from event to alert)
- Unauthorized access attempts detected
- Compliance violations found (if any)
- Security skill library growth

**Learning**
- Skill library size (count of procedures documented)
- Skill reuse rate (% of new incidents resolved via existing skills)
- Skill success rate (% of skill executions that resolve issue)
- Memory recall accuracy (% of recalled facts still relevant)

**Operational Efficiency**
- Operator interaction time per week (hours)
- Approvals required (% of operations needing human sign-off)
- Cost per incident (API calls + operator time)
- Merchant satisfaction (subjective but trackable)

---

## 10. Risk Mitigation

### Risks and Mitigations

**Risk: COSA makes a wrong decision and breaks the appliance**
- *Mitigation 1:* Small-scope changes with risk scoring — code changes are scoped to minimize blast radius. Risk is evaluated before execution (e.g., moving a button = low risk; modifying business logic = high risk).
- *Mitigation 2:* Test framework validation — all code changes must pass the full test suite before approval.
- *Mitigation 3:* 100% rollback capability — rollback procedures are documented and tested for every skill and code change.
- *Mitigation 4:* All write operations require approval or are read-only by default
- *Mitigation 5:* Code changes require independent review (via subagent delegation) before deployment
- *Mitigation 6:* Health check runs immediately post-deployment to verify appliance integrity

**Risk: API key or credential leak**
- *Mitigation 1:* Credentials never logged or stored in conversation
- *Mitigation 2:* Environment isolation ensures sandbox doesn't see credentials
- *Mitigation 3:* Credential rotation reminders and procedures documented
- *Mitigation 4:* Access logs track all credential usage

**Risk: COSA becomes confused and goes into a loop**
- *Mitigation 1:* Iteration limits on conversation loop (max 20 iterations)
- *Mitigation 2:* Human override always available (Telegram command)
- *Mitigation 3:* Dangerous operations require explicit approval
- *Mitigation 4:* Context compression prevents runaway memory use

**Risk: Skill library becomes incorrect or outdated**
- *Mitigation 1:* Skills are versioned and timestamped
- *Mitigation 2:* Skill execution is logged; failure rate tracked
- *Mitigation 3:* Operator can mark skills as deprecated
- *Mitigation 4:* Episodic memory (session logs) is source of truth; skills are recipes

**Risk: Cron jobs consume too many API calls**
- *Mitigation 1:* Health check tool is lightweight (no LLM inference)
- *Mitigation 2:* LLM inference only triggered on anomalies
- *Mitigation 3:* Cron schedule can be adjusted or disabled
- *Mitigation 4:* API call budget tracked and reported in daily summary

---

## 11. Conclusion

COSA represents the natural evolution of applying autonomous agents to appliance management. By borrowing Hermes's proven patterns — closed learning loops, persistent memory, composable tool systems, and defense-in-depth security — COSA can evolve from a reactive monitoring system into a proactive, learning partner that handles the code, operational, and security aspects of running a modern appliance.

The framework is generic enough to apply to any application (payment systems, inventory management, smart appliances, etc.). The customization happens via context files and tool configuration, not rewrites of the core agent.

The merchant's job becomes simpler: set COSA on the appliance, review alerts and reports, approve critical changes. The merchant doesn't think about updates, backups, security scans, or operational procedures — COSA does that autonomously, learning from every incident it resolves.