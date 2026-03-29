# COSA Functional Specification

**Version:** 1.0
**Date:** 2026-03-28
**Branch:** architecture
**Status:** Functional Specification

---

## 1. Overview

COSA (Code-Operate-Secure Agent) is a persistent, autonomous agent that manages a software appliance through its complete lifecycle: development (code), operations (health, monitoring, repair), and security (defense, detection, incident response). COSA runs headless on a dedicated machine on the same local network as the appliance and communicates with operators via email.

The first target appliance is **Baanbaan**, a POS relay for small restaurants running on ARM hardware with a Bun/SQLite/SAM stack.

### Core Promise

COSA enables restaurant operators to run a business-critical appliance (Baanbaan) without dedicated on-site DevOps/security staff. COSA handles:
- **Routine operations** (backups, health checks, health reporting) completely autonomously
- **Incident response** (stuck orders, network issues, intrusions) by diagnosing and proposing fixes
- **Code maintenance** (bug fixes, security patches) by implementing, testing, and staging for operator approval
- **Regulatory compliance** (PCI assessments, access logs, audit trails) by automating verification and reporting

---

## 2. Operator Personas and Workflows

### Persona: Restaurant Manager/Operator

**What they do:**
- Check email daily for operational summaries
- Approve high-impact changes (deployments, tunnel kills) via email reply
- Alert COSA to issues ("printer not printing", "orders stuck") via email
- Review security alerts if something unusual is detected

**What they should NOT do:**
- Log into the Baanbaan Pi or COSA Pi
- Run manual commands
- Monitor dashboards or logs

### Persona: Security Auditor / Compliance Officer

**What they do:**
- Request PCI assessments and compliance reports
- Review COSA's audit log of all operations and approvals
- Verify that no unauthorized changes reached production

**What they should NOT do:**
- Approve or deny routine operational changes (manager approves those)
- Access the appliance directly

---

## 3. User Interactions (Interfaces)

### 3.1 Email Interface (Primary)

Email is the sole human-facing interface for Phase 1. The operator sends plain-text email to COSA's address, and COSA responds with results, approval requests, or alerts.

**Operator → COSA (Inbound)**

- **Query:** `Is the printer working?` → COSA checks printer status, replies with result
- **Command:** `Can we deploy the fix for the payment timeout bug?` → COSA summarizes the change, proposes deployment, awaits approval
- **Alert:** `We're seeing errors in the receipt printer logs` → COSA escalates to a Claude Code investigation session

**COSA → Operator (Outbound)**

- **Routine Reports** (sent without request, per cron schedule):
  - Daily shift summary (orders processed, revenue, errors)
  - Weekly compliance digest (git audit, access logs, network anomalies)
  - Monthly PCI self-assessment report

- **Alerts** (sent on anomaly or escalation):
  - Health degradation ("POS adapter offline for 5 minutes")
  - Security anomaly ("Unknown process started: pid 1234")
  - Failed critical operation ("Nightly backup failed")
  - Approval requests ("COSA found and fixed a bug; needs approval to deploy")

- **Approval Request Email Format:**
  ```
  Subject: [COSA] Approval Needed: Deploy hotfix for payment timeout
  
  What I want to do:
    git commit -m "Fix: increase payment timeout from 30s to 60s"
    bun test
    deploy
  
  Why:
    Timeout is too aggressive; legitimate Clover API calls are failing.
    Current error rate: 2.3% of transactions.
  
  Risk level: Low (single config value; 98% test coverage)
  
  If you approve, reply to this email with: APPROVE-[TOKEN]
  This approval is valid for 30 minutes.
  
  If you deny, reply with: DENY and explain why.
  If neither, the request will auto-deny in 30 minutes.
  ```

- **Approval Response:** Operator replies with `APPROVE-xyz123` or `DENY`
  - COSA verifies the token, executes the action, and confirms the outcome by return email

### 3.2 CLI Interface (Operator / Engineer)

Local terminal on the COSA Pi for setup, debugging, and session history review. Not used during normal operation.

```bash
cosa --help
cosa query "How many orders failed yesterday?"
cosa session-history --since 2026-03-20
cosa skill-view printer-offline-recovery
```

### 3.3 Cron Scheduler (Autonomous)

No operator interaction required. COSA runs scheduled agent tasks on a predefined cron schedule. Results are logged and sent as email reports per §3.1 (Routine Reports).

---

## 4. Functional Domains and Observable Behaviors

### 4.1 OPERATE Domain: Health, Monitoring, Repair

**What operators should observe:**

1. **Daily Shift Report** (every morning ~6am)
   - Total orders processed yesterday
   - Total revenue
   - Error count and error categories
   - Printer uptime %
   - POS adapter uptime %
   - Backup status (success/failure)
   - Any alerts from previous day

2. **Health Alerts** (hourly, only if anomaly detected)
   - "POS adapter offline (5 min elapsed, retrying every 30s)"
   - "Printer offline (no successful print in 45 min)"
   - "Database integrity check warning: 2 corrupt pages detected"
   - "Disk space low: 78% used"
   - "Process supervisor detected crash and restarted Baanbaan service"

3. **Recovery Actions** (automatic, logged)
   - Printer detected offline → COSA runs printer self-check → if still offline, sends alert
   - Database corruption detected → COSA spawns Claude Code session to diagnose, offers repair recommendation
   - Stuck order detected (SAM state machine in error state for >30 min) → COSA runs recovery procedure (retry, cancel with customer notification, or escalate)

4. **Backup Integrity** (daily 3:00 AM)
   - Backup completes successfully → logged
   - Backup fails → alert sent immediately with reason (S3 unreachable, disk full, etc.)
   - Backup checksum mismatch → alert sent (corrupted backup detected, restore may be unsafe)

5. **Operator Issues Database Corruption**
   - Operator sends email: "We're getting errors when running reports; something's wrong with the database."
   - COSA runs `db_integrity`; if corruption detected, spawns Claude Code CLI session
   - Claude Code diagnoses the corruption, performs targeted repair (PRAGMA integrity_check, page reconstruction, etc.), and commits changes
   - COSA reviews the diff, approves, and applies the fix
   - Operator receives confirmation email with summary of what was fixed

### 4.2 SECURE Domain: Intrusion Detection, Compliance, Hardening

**What operators should observe:**

1. **Weekly Security Digest** (every Monday 2:00 AM)
   - Git audit: any force-pushes, unsigned commits, or unexpected branches
   - Access log summary: login attempts, failed requests, anomalies
   - Running processes: any unknown PIDs not in expected list
   - Network connections: any unexpected IPs (devices off the known-good LAN)
   - Credential exposure check: any secrets found in git working tree
   - Network connectivity: Cloudflare tunnel uptime %

2. **Security Alerts** (sent immediately on anomaly)
   - **Low severity** (logged, included in weekly digest):
     - "Force-push detected on main branch (commit abc123def): manual review recommended"
   - **Medium severity** (email alert, 15-min operator response window):
     - "Unknown IP attempting SSH: 192.168.1.99. Flagged as suspicious. If unauthorized, reply with: BLOCK-IP"
   - **High severity** (email alert, 5-min response window, then auto-action):
     - "Multiple failed login attempts from 192.168.1.50 in last 10 min. Blocking further attempts. If this is a legitimate admin, reply: UNBLOCK-IP"
   - **Critical severity** (auto-action first, email second):
     - "Unauthorized process detected: PID 8392 (binary: unknown). Killing Cloudflare tunnel immediately. Baanbaan POS is now offline from external customers. Reply RESTART to restore. Full incident log attached."

3. **Compliance Reports**
   - **Monthly PCI Self-Assessment** (1st of month, 2:00 AM):
     - Checklist of PCI-DSS requirements
     - Status of each requirement (✓ Compliant / ⚠ Warning / ✗ Non-compliant)
     - Actionable recommendations for any non-compliance
   - **JWT Secret Rotation Reminder** (1st of month):
     - Current JWT secret last rotated: [date]
     - Recommendation: rotate if >90 days old
   - **Token Rotation Reminder**:
     - Clover API token status
     - Recommendation: rotate every 6 months (security best practice)

4. **Intrusion Response Escalation** (real example scenario)
   - Unusual process starts on Baanbaan (not in expected list)
   - COSA classifies severity as "High" (unknown binary, listening port)
   - COSA kills Cloudflare tunnel → POS goes offline from internet
   - COSA sends alert email: "Potential intrusion detected. Cloudflare tunnel disabled. Baanbaan POS is offline. Reply CLEAR-THREAT to restart tunnel."
   - Operator reviews COSA's evidence (process name, listening port, anomaly score) → replies CLEAR-THREAT
   - COSA restarts Cloudflare tunnel → POS comes back online
   - Full incident log written to session.db for audit

### 4.3 CODE Domain: Development, Testing, Deployment

**What operators should observe:**

1. **Bug Detection and Fix** (autonomous, with approval gate)
   - COSA detects a bug (e.g., recurring error in logs: "payment timeout")
   - COSA spawns Claude Code CLI session to fix it
   - Claude Code makes the fix, runs tests, commits with detailed message
   - COSA reviews diff, runs full test suite, spawns independent code reviewer
   - Independent reviewer approves the fix
   - COSA sends approval request email: "Found and fixed payment timeout bug. Risk: Low. Ready to deploy. Reply APPROVE or DENY."
   - Operator approves → COSA deploys → health check passes → operator gets confirmation email

2. **Dependency Vulnerability Alert** (weekly)
   - Weekly CVE scan runs on package.json dependencies
   - Vulnerability found (e.g., "express 4.17.0 has CVE-2025-1234")
   - If patch-level fix available (4.17.0 → 4.17.1):
     - COSA auto-updates, runs tests, deploys (low-risk auto-deploy)
     - Operator gets notification: "Dependency auto-updated: express 4.17.0 → 4.17.1 (CVE fix)"
   - If major/minor version required:
     - COSA sends approval request: "Requires upgrade: express 4.17.0 → 5.0.0 (security patch). Full test suite passes. Ready to deploy. Approve?"

3. **Deployment Workflow** (operator initiates or COSA initiates)
   - Operator or COSA proposes a code change
   - Change is tested and reviewed
   - COSA sends approval request email with:
     - Summary of change
     - Risk classification (Low / Medium / High)
     - Test results
     - Review result
     - Estimated downtime (usually 0 for graceful restart)
   - Operator approves → COSA deploys
   - After deploy, COSA verifies health (health_check passes, POS adapter connected, orders flowing)
   - If health check fails, COSA auto-rolls back and alerts operator

4. **Rollback** (operator-initiated or auto-triggered on deploy failure)
   - Deploy fails or health check fails post-deploy
   - COSA checks auto-rollback conditions:
     - If deployment is <1 hour old: auto-rollback (low risk to go back)
     - Otherwise: send approval request asking operator permission to rollback
   - Rollback executes → health check passes → operator gets confirmation

---

## 5. System Guarantees and Constraints

### 5.1 Headless Autonomy

**Guarantee:** COSA performs all routine operations without human intervention.

Routine operations:
- Health checks (hourly)
- Backups (daily)
- Shift reports (daily)
- Cron audit tasks (weekly)

**Constraint:** High-impact or irreversible actions require explicit operator approval via email:
- Deploying code changes
- Killing the Cloudflare tunnel (intrusion response)
- Pausing the appliance service
- Updating appliance settings

### 5.2 Security and Risk Isolation

**Guarantee:** All tool calls pass through a security gate before execution.

- Dangerous command patterns detected (e.g., `rm -rf`, `DROP TABLE`)
- Tool outputs sanitized to strip credentials before entering conversation
- All actions logged immutably to session.db with timestamp, operator approval, and outcome

**Constraint:** COSA has no write access to appliance settings without operator approval. No deployment without test suite passing. No emergency actions without approval (except auto-kill Cloudflare in Critical intrusion, TBD).

### 5.3 Operational Continuity

**Guarantee:** If COSA encounters an incident it cannot resolve with existing tools, it escalates to a Claude Code CLI session on the appliance, where the repair can be done interactively.

Examples:
- Database corruption → Claude Code diagnoses and repairs
- Stuck SAM state that cannot be resolved by retry → Claude Code inspects state JSON, applies targeted fix
- Complex multi-file refactor → Claude Code handles it in one session

**Constraint:** All Claude Code sessions logged and reviewed; changes committed and reviewable before being applied.

### 5.4 Cost and Performance

**Guarantee:** Layered prompt caching reduces API costs to ~10% of naive per-call cost.

- System context (core identity, appliance info, operations guide) cached indefinitely
- Skill index cached per session
- Per-turn cost ~500 tokens for read-only queries, ~2000 tokens for decisions

**Constraint:** High-cost operations (Claude Opus for critical decisions) reserved for actual decisions, not every query.

---

## 6. Workflows: Key Scenarios

### Scenario 1: Operator Notices Printer Offline

**Trigger:** Operator sends email: "The printer isn't printing. Can you check?"

**COSA's workflow:**
1. Receive email from operator
2. Call `printer_status` tool → returns "offline, last successful print 47 minutes ago"
3. Call `pos_health` tool → returns "connected, all orders submitted successfully"
4. Reply email: "Printer has been offline for ~45 minutes. No orders are stuck (they're all in the POS system). Likely causes: (1) power loss, (2) network disconnect, (3) buffer overflow. Check: Is the printer powered on? Is the Ethernet cable connected? If both yes, it may need a power cycle — I can coordinate that with you."
5. Operator replies: "I just restarted it. It's printing again."
6. COSA waits for next health check (1 hour) → confirms printer is back online → sends confirmation email: "Printer confirmed online. All systems healthy."

### Scenario 2: COSA Detects a Recurring Bug

**Trigger:** Nightly cron log audit detects a pattern: "Payment timeout (error 001)" appears in logs 5+ times in the past 24 hours.

**COSA's workflow:**
1. Recognize error pattern from skill library: no existing skill for this error
2. Query application logs for context → timeout occurring in Clover payment adapter
3. Spawn Claude Code CLI session on Baanbaan
4. Within that session, Claude Code:
   - Inspects payment adapter code → finds timeout hardcoded to 30 seconds
   - Checks Clover API documentation → legitimate API calls sometimes take 40+ seconds
   - Makes fix: increase timeout to 60 seconds
   - Runs test suite → all tests pass
   - Commits: `git commit -m "Fix: increase Clover payment timeout 30s → 60s\n\nRootcause: legitimate Clover API calls sometimes exceed 30s, causing spurious timeouts. Error rate dropped from 2.3% to 0.1% in testing."`
5. COSA reviews diff → change is minimal and low-risk
6. Spawn independent code reviewer agent → reviews change and approves
7. COSA sends approval request email to operator: "Found and fixed recurring bug: payment timeout. 5 occurrences in last 24h. Fix: increase timeout. Risk level: Low. Test suite: 100% pass. Code review: approved. Ready to deploy. Approve?"
8. Operator replies: "APPROVE-abc123"
9. COSA deploys → runs health check → confirms POS adapter working, orders flowing → replies: "Deploy successful. Payment timeout fixed. Monitoring for recurrence."
10. Next week, no payment timeout errors in logs → COSA marks skill as "proven" and reuses it if similar pattern appears

### Scenario 3: Unauthorized SSH Login Attempt (Security Response)

**Trigger:** Access log contains failed SSH login attempts from unknown IP (192.168.1.50) appearing 8 times in 5 minutes.

**COSA's workflow:**
1. Classify severity as "High" (multiple login attempts from unknown IP = potential brute force)
2. Call `network_scan` tool → confirm 192.168.1.50 is not in known-good MAC list
3. Classification: High severity → requires immediate action
4. Execute `cloudflare_kill` → POS tunnel goes offline
5. Send alert email: "Potential intrusion detected. Cloudflare tunnel killed. POS is offline from internet.\n\nEvidence:\n- Multiple failed SSH attempts from 192.168.1.50 (8 attempts in 5 min)\n- IP not in known-good inventory\n\nAction taken: Cloudflare tunnel killed to isolate appliance.\n\nNext steps:\n- If this is a legitimate admin on your network, reply: CLEAR-THREAT\n- If this is a real intrusion, contact your network admin; do NOT clear threat\n\nFull incident log: [session.db link]"
6. Operator investigates network, determines it was a misconfigured admin laptop attempting password-based SSH
7. Operator replies: "CLEAR-THREAT"
8. COSA verifies token → restarts Cloudflare → POS comes back online
9. COSA sends follow-up: "Threat cleared. Cloudflare tunnel restarted. POS online. Recommendation: configure SSH key-only authentication to prevent future brute-force attempts. I can implement this with your approval."

---

## 7. Data and State Management

### 7.1 Persistent State COSA Maintains

**session.db** (SQLite, on COSA Pi)
- Every turn, every tool call, every approval
- FTS5 full-text index for cross-session search
- Retention: permanent (audit trail)
- Queries: "What did we do last time the printer went offline?", "Has this error appeared before?"

**MEMORY.md** (plain text, on COSA Pi)
- Current appliance health snapshot (~2200 char limit, hard enforced)
- Recent incidents and their resolutions
- Active skills summary
- Operator preferences (approval thresholds, contact info)
- Updated after each significant operation

**skills.db** (SQLite + markdown documents, on COSA Pi)
- Seed skills (8 for Baanbaan): printer recovery, stuck order recovery, backup verify, POS reconnect, git audit, tunnel restart, shift report, emergency pause
- Skill format: agentskills.io standard markdown
- Skill creation: post-incident if no existing skill matched and resolution required >2 tool calls
- Skill improvement: `## Experience` section appended on reuse with edge cases, timing data, success rate

**APPLIANCE.md** (static config, on COSA Pi)
- Baanbaan Pi SSH connection string (user, host, port)
- Appliance API base URL
- SQLite database path
- Process supervisor name (pm2 / systemd)
- POS adapter type (Clover, Toast, etc.)
- Cloudflare process name
- Escalation contact list
- Timezone
- Known-good MAC addresses (for network anomaly detection)

### 7.2 Credential Management

**Where credentials live:**
- SSH private key: encrypted store on COSA Pi, never logged
- Clover API key: encrypted store, never logged
- Email account credentials: encrypted store
- S3 bucket credentials: encrypted store

**Where credentials do NOT live:**
- Never in MEMORY.md or session.db (audit trail)
- Never passed to Claude Code sessions (isolation)
- Never in git (credential_audit detects and alerts)

**Credential access:**
- Only at tool call time
- Tool output sanitized before entering conversation
- Weekly credential_audit checks for exposure

---

## 8. Acceptance Criteria and Success Metrics

### Phase 1 Exit Criteria: Foundation
- [ ] Operator sends email query → COSA responds within 2 minutes with accurate health status
- [ ] Cron health check runs hourly without intervention
- [ ] If appliance unhealthy → operator receives alert email within 5 minutes
- [ ] Operator replies to approval email with token → COSA executes action within 1 minute
- [ ] All tool calls logged immutably to session.db
- [ ] Dangerous command patterns (rm -rf, DROP TABLE, etc.) blocked before execution

### Phase 2 Exit Criteria: Operate
- [ ] Daily shift report delivered to operator inbox every morning
- [ ] Nightly backup runs autonomously, checksum verified, alerts sent on failure
- [ ] Stuck order detected automatically, recovery procedure runs, operator notified of outcome
- [ ] COSA creates a new skill from an incident that required novel work
- [ ] Skill reused on second occurrence of same issue, with 90%+ success rate
- [ ] session.db query: "What errors happened last week?" returns meaningful results
- [ ] Memory system (MEMORY.md) updated after each significant operation

### Phase 3 Exit Criteria: Secure
- [ ] Simulated intrusion (unauthorized SSH login attempt) detected automatically
- [ ] Cloudflare tunnel killed within 1 minute of intrusion detection
- [ ] Operator receives alert with full context and evidence
- [ ] Operator can approve/deny threat via email reply
- [ ] Weekly security digest includes git audit, access logs, unknown processes, network anomalies
- [ ] Monthly PCI self-assessment report delivered without request
- [ ] Credential audit finds no exposed secrets in git working tree

### Phase 4 Exit Criteria: Code
- [ ] COSA detects a bug, fixes it via Claude Code CLI, tests it, and proposes deployment
- [ ] Code review gate: independent reviewer approves the fix
- [ ] Operator approves deployment via email
- [ ] Deploy: health check passes, orders flowing, operator receives confirmation
- [ ] If deploy fails, auto-rollback and operator alerted
- [ ] Dependency audit: patch-level CVE fix auto-deployed without approval
- [ ] Major version vulnerability fix requires operator approval

### Success Metrics (Operational)
- **Availability:** Baanbaan uptime ≥ 99.5% (excluding planned maintenance)
- **MTTR (Mean Time To Resolution):**
  - Printer offline: detected in <5 min, alert sent in <5 min, human can fix in ~5 min
  - Database corruption: detected in <5 min, Claude Code session spawned in <5 min, fix implemented in <15 min
  - Intrusion: detected in <5 min, Cloudflare killed in <1 min
- **Approval throughput:** Operator can approve/deny changes via email in <5 min (async)
- **Cost:** API costs for 100 daily cron tasks + 50 email interactions ≤ $20/month (via caching)
- **Operator workload:** <30 min/day of email review (routine reports + approval requests)

---

## 9. Assumptions and Dependencies

### Assumptions
- Operator checks email at least once per day
- Baanbaan Pi is reachable via SSH from COSA Pi on the same LAN
- COSA Pi has outbound internet access (SMTP, IMAP, Claude API)
- Operator's email address is stable and accessible
- No other automation tool is managing Baanbaan (to avoid conflicts)

### External Dependencies
- **Claude API** (Anthropic) — for agent reasoning and code generation
- **Email provider** (SMTP/IMAP) — for operator communication
- **S3 or similar storage** — for off-site backups
- **Tirith binary** (security scanner) — for dangerous command detection
- **SSH** — for appliance connectivity (standard)

### Single Points of Failure (and Mitigations)
- **COSA Pi crash:** Restart via physical access or network reboot. Session state persists in session.db.
- **Baanbaan Pi crash:** COSA detects in health check, alerts operator. Operator physically restarts or remotely via process supervisor.
- **Network outage:** COSA detects appliance unreachable, sends alert via email (once connectivity restored). Operator fixes network.
- **Email outage:** Operator and COSA cannot communicate. Once email restored, COSA sends buffered alerts. Not mitigated — email is single point of failure.

---

## 10. Out of Scope (Phase 1–5)

- **Multi-appliance orchestration:** Deferred until Phase 5 (Baanbaan must be proven stable first)
- **Custom skill development by operator:** Skills are auto-created by COSA from incidents
- **Real-time monitoring dashboard:** Email and cron reports are sufficient for Phase 1–4
- **Mobile app:** Email is the interface
- **Automated remediation for Critical intrusions:** Phase 3 implements approval-required response; auto-permit for Critical events is deferred pending false positive data