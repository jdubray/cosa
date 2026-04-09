# Phase 3 — Secure: Implementation Specification

**Version:** 1.0
**Date:** 2026-03-28
**Branch:** architecture
**Status:** Implementation Specification — Ready for Review

---

## 1. Scope

Phase 3 builds COSA's security layer: continuous monitoring, anomaly detection, intrusion response, and compliance verification. At the end of Phase 3, COSA will autonomously detect intrusions, respond by killing the Cloudflare tunnel, and page the operator with full incident context.

**What Phase 3 builds:**
- Tirith pre-execution security scanner (integrated into the tool gate)
- Full SECURE tool set (9 monitoring tools + 4 response tools)
- Intrusion escalation FSM (classification → response → recovery)
- Encrypted credential store
- Security-specific cron additions (git audit, process monitor, log scan, network scan)
- PCI self-assessment checklist
- Anomaly classifier (Low / Medium / High / Critical)

**What Phase 3 does NOT build:**
- Auto-permit override for `cloudflare_kill` in Critical mode (deferred, see §9)
- Telegram/PWA interface (Phase 2+ optional)
- Code modification tools (Phase 4)

**Prerequisites from Phases 1 and 2:**
- COSA core loop and tool registry running
- SSH backend to Baanbaan Pi operational
- Email gateway (IMAP + SMTP) working and tested with approval tokens
- session.db with FTS5 full-text search
- `health_check`, `db_query`, `db_integrity` tools in service
- Cron scheduler operational (at minimum 1h health check)
- APPLIANCE.md and OPERATIONS.md seeded with Baanbaan config
- Approval system (once/session/always/deny) working end-to-end

---

## 2. Security Monitoring Architecture

COSA monitors Baanbaan from the COSA Pi over local SSH. There are no inbound ports on either Pi. Monitoring is entirely outbound (COSA → Baanbaan) via SSH commands and the Baanbaan HTTP API.

```
COSA Pi (monitor)                    Baanbaan Pi (monitored)
┌─────────────────────┐              ┌──────────────────────────────┐
│                     │              │                              │
│  Security Scheduler │──SSH──────▶ │  /var/log/auth.log           │
│  (cron every 6h)    │              │  /var/log/syslog             │
│                     │──SSH──────▶ │  ps aux (process list)       │
│  Anomaly Classifier │              │  ss -tulpn (connections)     │
│                     │──SSH──────▶ │  git log (repo audit)        │
│  Escalation FSM     │              │  access logs (Hono HTTP)     │
│                     │              │                              │
│  Tirith Gate        │──HTTP─────▶ │  GET /health                 │
│                     │              │  GET /health/ready           │
│  Alert Engine       │──SMTP─────▶ │  [operator email]            │
│                     │              │                              │
└─────────────────────┘              └──────────────────────────────┘
```

### 2.1 Known-Good Baseline (APPLIANCE.md)

The following fields must be present in `APPLIANCE.md` before Phase 3 can run:

```markdown
## Security Baseline

### Known Processes
# Processes that should always be running on Baanbaan Pi
expected_processes:
  - name: "bun"             # Main appliance process
    binary: "/root/.bun/bin/bun"
    ports: [3000]
  - name: "cloudflared"     # Cloudflare tunnel
    binary: "/usr/local/bin/cloudflared"
    ports: []               # no local ports (outbound only)
  - name: "pm2"             # Process supervisor (or systemd)
    binary: "/usr/lib/node_modules/pm2/bin/pm2"
    ports: []
  - name: "sshd"            # SSH daemon
    binary: "/usr/sbin/sshd"
    ports: [22]

### Known Network Devices (same LAN)
known_mac_addresses:
  - mac: "dc:a6:32:xx:xx:xx"  name: "baanbaan-pi"
  - mac: "dc:a6:32:yy:yy:yy"  name: "cosa-pi"
  - mac: "xx:xx:xx:xx:xx:xx"  name: "pos-terminal-clover"
  - mac: "xx:xx:xx:xx:xx:xx"  name: "receipt-printer-star"

### Cloudflare
cloudflare_process_name: "cloudflared"
cloudflare_service_name: "cloudflared"     # systemd/pm2 service name

### SSH
ssh_authorized_keys_path: "/root/.ssh/authorized_keys"
expected_ssh_key_fingerprints:
  - "SHA256:xxxxxx"    # COSA Pi key
  - "SHA256:yyyyyy"    # Developer key

### Git Repository
repo_path: "/home/baanbaan/app"
expected_git_authors:
  - "developer@domain.com"
  - "cosa@local"

### Credential Store References
# Symbolic names only — actual values in encrypted store
credentials:
  - name: clover_api_key
  - name: s3_access_key
  - name: jwt_secret
  - name: cloudflare_tunnel_token
  - name: smtp_password

### Compliance
jwt_secret_last_rotated: "2026-01-15"
clover_token_last_rotated: "2025-11-01"
last_pci_assessment: "2026-02-01"
```

---

## 3. Tirith Integration

Tirith is a Rust binary that scans commands for content-level threats before execution. It is the first line of defense in the tool execution gate, running on every tool call before the approval gate.

### 3.1 Installation

On first COSA startup (or via `cosa setup`):

```
1. Check if ~/.cosa/bin/tirith exists and is current version
2. If not: download from Hermes release URL to ~/.cosa/bin/tirith
3. chmod +x ~/.cosa/bin/tirith
4. Run ~/.cosa/bin/tirith --version to verify
5. Log installation to session.db
```

The Tirith binary is NOT downloaded at runtime. It is installed once and verified on startup. If Tirith is unavailable, COSA falls back to dangerous-cmd detection only and logs a warning.

### 3.2 Integration Point

Tirith is inserted as step 1 in the tool execution gate, before dangerous-cmd detection:

```
Tool call proposed by LLM
         │
         ▼
[1] Tirith scan (content-level)
    └── homograph URLs, shell injections, obfuscated payloads, hex-encoded commands
    └── if threat: BLOCK + log + explain to LLM
         │ clean
         ▼
[2] Dangerous command detection (regex)
    └── rm -rf, DROP TABLE, killall, credential patterns
    └── if match: BLOCK or route to approval gate
         │ clean
         ▼
[3] Approval gate
    └── check tool risk level against policy
    └── if approval required: send email, await reply
         │ approved or auto-permitted
         ▼
[4] Execute tool
         │
         ▼
[5] Output sanitization
    └── strip credential patterns from output before returning to LLM
         │
         ▼
[6] Log to session.db (tool name, args, output hash, duration, approval record)
```

### 3.3 Tirith Configuration

```yaml
# ~/.cosa/tirith.yaml
mode: block           # block | warn | audit
log_path: ~/.cosa/tirith.log
threat_patterns:
  - homograph_urls: true
  - shell_injections: true
  - obfuscated_payloads: true
  - hex_encoded_commands: true
  - base64_commands: true
exceptions:
  - tool: bun_test    # test runner may use complex arguments
  - tool: db_query    # SQL is expected
```

---

## 4. SECURE Tool Specifications

### 4.1 git_audit

**Purpose:** Inspect recent git log for unauthorized commits, force-pushes, unexpected authors, and unexpected branches.

**When called:**
- Cron: every 6 hours
- Ad-hoc: operator email query

**Input:**
```typescript
interface GitAuditInput {
  repoPath: string           // from APPLIANCE.md
  lookbackHours?: number     // default: 8 (covers 6h cron + buffer)
  expectedAuthors: string[]  // from APPLIANCE.md
}
```

**Implementation (SSH command):**
```bash
# On Baanbaan Pi via SSH:
git -C /home/baanbaan/app log \
  --since="8 hours ago" \
  --pretty=format:"%H|%ae|%ai|%s|%D" \
  --all
```

**Output:**
```typescript
interface GitAuditResult {
  ok: boolean
  commits: Array<{
    hash: string
    author: string
    timestamp: string
    subject: string
    refs: string       // branch/tag refs
    suspicious: boolean
    reason?: string    // why it's suspicious
  }>
  forcePushDetected: boolean
  unknownBranches: string[]
  severity: 'clean' | 'low' | 'medium' | 'high'
}
```

**Anomaly Classification:**

| Condition | Severity |
|---|---|
| All commits from expected authors, no force push | clean |
| Commit from unexpected author | medium |
| Force push detected on main | high |
| Unknown branch with commits | medium |
| Commit subject contains suspicious pattern (e.g., `eval`, `exec`, base64) | high |

---

### 4.2 process_monitor

**Purpose:** List all running processes on Baanbaan, compare against known-good list, flag unexpected PIDs.

**When called:**
- Cron: every 6 hours
- Triggered: any time `health_check` returns anomalous CPU usage

**Input:**
```typescript
interface ProcessMonitorInput {
  sshTarget: string              // from APPLIANCE.md
  expectedProcesses: Process[]   // from APPLIANCE.md security baseline
}
```

**Implementation (SSH command):**
```bash
# On Baanbaan Pi via SSH:
ps aux --no-headers | awk '{print $1,$2,$3,$4,$11}'
# Output: user pid cpu mem command
```

**Output:**
```typescript
interface ProcessMonitorResult {
  ok: boolean
  processes: Array<{
    user: string
    pid: number
    cpu: number
    mem: number
    command: string
    expected: boolean
    suspicious: boolean
    reason?: string
  }>
  unknownProcesses: Process[]
  listeningPorts: number[]       // unexpected open ports
  severity: 'clean' | 'low' | 'medium' | 'high' | 'critical'
}
```

**Anomaly Classification:**

| Condition | Severity |
|---|---|
| All processes in expected list | clean |
| Unknown process (not in expected list) | medium |
| Unknown process listening on a port | high |
| Unknown process with root privileges | high |
| Known process on unexpected port | medium |
| Process with suspicious binary name or path | critical |

---

### 4.3 network_scan

**Purpose:** Enumerate all devices visible on the local network, compare against known-good MAC addresses, flag unknown devices.

**When called:**
- Cron: every 6 hours
- Triggered: when `process_monitor` finds a new listening port

**Input:**
```typescript
interface NetworkScanInput {
  sshTarget: string
  knownMacAddresses: Array<{ mac: string; name: string }>  // from APPLIANCE.md
  networkRange: string    // e.g., "192.168.1.0/24"
}
```

**Implementation (SSH command):**
```bash
# On Baanbaan Pi via SSH:
# ARP scan (nmap not required — uses arp-scan or arp -a)
arp -a
# Alternatively, if nmap available:
nmap -sn 192.168.1.0/24 --output-format=xml
```

**Output:**
```typescript
interface NetworkScanResult {
  ok: boolean
  devices: Array<{
    ip: string
    mac: string
    vendor?: string
    hostname?: string
    known: boolean
    name?: string    // from known_mac_addresses if matched
  }>
  unknownDevices: Device[]
  severity: 'clean' | 'low' | 'medium' | 'high'
}
```

**Anomaly Classification:**

| Condition | Severity |
|---|---|
| All MACs in known-good list | clean |
| Unknown MAC on network (first time) | medium |
| Unknown MAC actively connecting to appliance port | high |
| Multiple unknown MACs appearing simultaneously | high |

---

### 4.4 access_log_scan

**Purpose:** Scan Baanbaan's HTTP access logs for anomalies: brute force login attempts, unusual endpoint access patterns, suspicious user agents, high error rates.

**When called:**
- Cron: every 6 hours
- Triggered: when `health_check` reports elevated 4xx/5xx error counts

**Input:**
```typescript
interface AccessLogScanInput {
  sshTarget: string
  logPath: string         // e.g., /var/log/baanbaan/access.log
  lookbackMinutes: number  // default: 380 (covers 6h cron + buffer)
}
```

**Implementation (SSH command):**
```bash
# On Baanbaan Pi via SSH:
tail -n 50000 /var/log/baanbaan/access.log | \
  awk '{print $1,$7,$9,$11}' | \
  grep -v "200\|304"  # focus on errors/unusual
```

**What to scan for:**

| Pattern | Detection | Severity |
|---|---|---|
| Failed POST /api/auth/login > 5x in 5 min, same IP | Brute force | High |
| POST /api/orders with invalid JSON > 10x in 1 min | Probe/fuzzing | Medium |
| GET to non-existent routes > 50x in 10 min | Path scanning | Medium |
| Access to /api/appliance/* from non-local IP | Internal route exposure | High |
| Requests with common SQL injection patterns in query params | SQLi probe | High |
| User agent matching known scanner (sqlmap, nikto, etc.) | Active scan | High |
| Requests containing script tags or eval( in body | XSS probe | Medium |

**Output:**
```typescript
interface AccessLogScanResult {
  ok: boolean
  anomalies: Array<{
    type: 'brute_force' | 'path_scan' | 'injection_probe' | 'internal_exposure' | 'active_scan'
    sourceIp: string
    endpoint: string
    count: number
    windowMinutes: number
    sample: string      // example request
    severity: 'low' | 'medium' | 'high'
  }>
  errorRatePercent: number
  totalRequests: number
  severity: 'clean' | 'low' | 'medium' | 'high'
}
```

---

### 4.5 cloudflare_kill

**Purpose:** Kill the Cloudflare tunnel process on Baanbaan, immediately cutting off all external access to the POS. The appliance remains reachable from the local network.

**Risk level:** Critical. Requires operator approval via email (auto-permit policy TBD — see §9).

**Input:**
```typescript
interface CloudflareKillInput {
  sshTarget: string
  processName: string    // from APPLIANCE.md: "cloudflared"
  serviceName: string    // systemd or pm2 service name
}
```

**Implementation:**
```bash
# On Baanbaan Pi via SSH:
# Try systemd first, fall back to process kill
systemctl stop cloudflared 2>/dev/null || \
  pm2 stop cloudflared 2>/dev/null || \
  kill $(pgrep cloudflared)
# Verify it's dead
sleep 2
pgrep cloudflared && echo "STILL_RUNNING" || echo "KILLED"
```

**Output:**
```typescript
interface CloudflareKillResult {
  success: boolean
  method: 'systemctl' | 'pm2' | 'kill'
  verificationPass: boolean    // confirmed process is gone
  timestamp: string
}
```

**Post-execution:**
1. Log to session.db with full incident context
2. Update MEMORY.md: "Cloudflare tunnel killed at {timestamp}. Reason: {incident}"
3. Send alert email immediately (do not wait for next poll)

---

### 4.6 pause_appliance

**Purpose:** Stop the Baanbaan service (pm2 or systemd). POS goes offline for all users. More extreme than `cloudflare_kill` — used only when the threat is inside the appliance process itself, not just at the tunnel.

**Risk level:** Critical. Always requires explicit operator approval (no auto-permit, ever).

**Input:**
```typescript
interface PauseApplianceInput {
  sshTarget: string
  supervisor: 'pm2' | 'systemd'
  serviceName: string    // from APPLIANCE.md
}
```

**Implementation:**
```bash
# On Baanbaan Pi via SSH:
pm2 stop baanbaan   # if pm2
# or
systemctl stop baanbaan   # if systemd
# Verify
sleep 2
curl -sf http://localhost:3000/health && echo "STILL_RUNNING" || echo "STOPPED"
```

**Output:**
```typescript
interface PauseApplianceResult {
  success: boolean
  supervisor: 'pm2' | 'systemd'
  verificationPass: boolean    // confirmed service is stopped
  timestamp: string
}
```

---

### 4.7 credential_audit

**Purpose:** Scan the Baanbaan git working tree and configuration files for accidentally committed credentials (API keys, tokens, passwords, private keys).

**When called:**
- Cron: weekly (Monday 2:00 AM)
- Ad-hoc: operator request

**Implementation (SSH command):**
```bash
# On Baanbaan Pi via SSH:
# Scan for common credential patterns in tracked files
git -C /home/baanbaan/app grep -nE \
  "(sk_live_|pk_live_|AKIA[0-9A-Z]{16}|[a-zA-Z0-9+/]{40,}==|password\s*=\s*['\"][^'\"]{8,}['\"])" \
  -- '*.ts' '*.js' '*.json' '*.env' '*.yaml' '*.yml'

# Check .gitignore coverage
cat /home/baanbaan/app/.gitignore | grep -E "(\.env|secrets|credentials)"
```

**Output:**
```typescript
interface CredentialAuditResult {
  ok: boolean
  findings: Array<{
    file: string
    line: number
    pattern: string    // which regex matched
    severity: 'low' | 'medium' | 'high'
    snippet: string    // redacted snippet for context
  }>
  gitignoreCoverage: {
    envFilesIgnored: boolean
    secretsDirectoryIgnored: boolean
  }
  severity: 'clean' | 'low' | 'medium' | 'high'
}
```

---

### 4.8 pci_assessment

**Purpose:** Run a PCI-DSS SAQ-A self-assessment checklist against the Baanbaan configuration. SAQ-A applies because Baanbaan delegates all payment processing to Clover and uses hosted payment fields (Finix).

**When called:**
- Cron: monthly (1st, 2:00 AM)
- Ad-hoc: compliance officer request

**SAQ-A Checklist Items:**

| Req | Description | How COSA Verifies |
|---|---|---|
| 2.1 | No default vendor-supplied passwords | Check known credential patterns against defaults |
| 2.2 | Only necessary services enabled | Process monitor + port scan |
| 6.1 | All software kept up to date | dep_audit — check for known CVEs |
| 6.2 | No publicly known vulnerabilities | dep_audit — bun audit |
| 8.1 | Unique user IDs for all users | Check /etc/passwd for shared accounts |
| 8.2 | Strong passwords/SSH keys enforced | Check SSH config: PasswordAuthentication no |
| 8.6 | Multi-factor authentication (if applicable) | Check SSH config |
| 9.1 | Restrict physical access (out of scope for COSA) | Manual (flag as manual check) |
| 10.1 | Audit log all access | Verify Hono access logging active |
| 10.2 | Log all admin actions | session.db coverage |
| 10.5 | Logs protected from modification | Check log file permissions |
| 11.2 | Run external vulnerability scans quarterly | Flag as manual / out of COSA scope |
| 12.1 | Security policy documented | Check for SECURITY.md in repo |

**Output:**
```typescript
interface PciAssessmentResult {
  assessmentDate: string
  scope: 'SAQ-A'
  requirements: Array<{
    id: string
    description: string
    status: 'pass' | 'fail' | 'warning' | 'manual'
    evidence?: string    // what COSA found
    recommendation?: string
  }>
  overallStatus: 'compliant' | 'non_compliant' | 'needs_review'
  actionItems: string[]
}
```

---

### 4.9 compliance_verify

**Purpose:** Verify the Baanbaan server configuration against a hardening baseline: SSH config, file permissions, service exposure.

**When called:**
- Cron: weekly (Monday 2:00 AM)
- Ad-hoc: operator request

**Checks:**
```bash
# SSH hardening
grep "PasswordAuthentication no" /etc/ssh/sshd_config
grep "PermitRootLogin" /etc/ssh/sshd_config
grep "MaxAuthTries 3" /etc/ssh/sshd_config

# File permissions
stat -c "%a %U" /home/baanbaan/app/.env 2>/dev/null
stat -c "%a %U" /home/baanbaan/data/merchant.db

# Listening services (only expected ports)
ss -tulpn | grep LISTEN

# Bun version vs latest
bun --version
```

---

### 4.10 jwt_secret_check

**Purpose:** Verify the JWT secret in use has adequate entropy and check when it was last rotated.

**Input:** Last rotation date from APPLIANCE.md. Actual secret value from encrypted store (never logged).

**Check:**
```typescript
// On COSA Pi (reads from encrypted store, never passes secret via SSH):
const secret = credentialStore.get('jwt_secret')
const entropy = measureEntropy(secret)  // Shannon entropy
const ageDays = daysSince(APPLIANCE.jwtSecretLastRotated)
```

**Output:**
```typescript
interface JwtSecretCheckResult {
  entropyBits: number      // should be > 128 bits
  ageDays: number
  lastRotated: string
  needsRotation: boolean   // true if > 90 days or entropy < 128
  recommendation?: string
}
```

---

### 4.11 webhook_hmac_verify

**Purpose:** Verify that HMAC signature validation is active on the POS webhook endpoint, ensuring POS callbacks cannot be spoofed.

**When called:**
- Cron: weekly
- Ad-hoc

**Implementation:**
```bash
# Test with invalid HMAC signature — should return 401
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3000/api/webhooks/pos/test-merchant \
  -H "X-Signature: invalid-signature" \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
# Expected: 401 (HMAC validation active)
# Dangerous: 200 (HMAC not validated — critical finding)
```

---

### 4.12 token_rotation_remind

**Purpose:** Check whether Clover API tokens and other rotatable credentials are due for rotation, and send operator reminders.

**Rotation policy:**
- Clover API key: every 6 months
- JWT secret: every 90 days
- S3 access key: every 90 days
- SSH authorized keys: review annually

---

### 4.13 ips_alert

**Purpose:** Send an immediate escalation email to the operator with incident context and evidence.

**Input:**
```typescript
interface IpsAlertInput {
  severity: 'low' | 'medium' | 'high' | 'critical'
  incidentType: string
  evidence: string[]          // list of evidence items
  actionsAlreadyTaken: string[]
  responseOptions: Array<{    // what operator can reply
    code: string              // e.g., "CLEAR-THREAT"
    description: string
  }>
  approvalToken?: string      // if approval is needed for next step
  autoExpireMinutes: number   // how long before auto-deny
}
```

**Email format:**
```
Subject: [COSA SECURITY] {severity}: {incidentType}

COSA detected a {severity}-severity security event on {appliance_name}.

What happened:
{incidentType}

Evidence:
{evidence items, one per line}

Actions already taken:
{actionsAlreadyTaken}

What to do:
{responseOptions with codes}

Reply to this email with the response code.
This alert expires in {autoExpireMinutes} minutes.

Full incident log: session #{sessionId}
```

---

## 5. Intrusion Escalation FSM

The escalation FSM governs how COSA transitions from anomaly detection through response and recovery. It is implemented using the same `sam-fsm` pattern as the Baanbaan appliance's own workflows, for consistency and testability.

### 5.1 State Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
           ┌────────▼──────────┐   anomaly_event                  │
           │    monitoring     │◄────────────────── recovered     │
           └────────┬──────────┘                                  │
                    │                                             │
           anomaly_detected                                       │
                    │                                             │
           ┌────────▼──────────┐                                  │
           │    classifying    │                                  │
           └────────┬──────────┘                                  │
                    │                                             │
         ┌──────────┼──────────────────────────────┐             │
         │          │                              │             │
    false_positive  │ low/medium              high/critical      │
         │          │                              │             │
         │  ┌───────▼────────┐        ┌────────────▼──────────┐  │
         │  │ alerting_      │        │  responding           │  │
         │  │ operator       │        │  (Cloudflare killed)  │  │
         │  └───────┬────────┘        └────────────┬──────────┘  │
         │          │                              │             │
         │    cleared/                    awaiting_clearance     │
         │    no_action                             │             │
         │          │               CLEAR-THREAT / PAUSE         │
         │          │                              │             │
         │          │              ┌───────────────▼──────────┐  │
         │          │              │   recovering             │  │
         │          │              │   (restoring services)   │  │
         │          │              └───────────────┬──────────┘  │
         │          │                              │             │
         └──────────┴──────────────────────────────┴─────────────┘
                                                   │
                                               health_check_pass
                                                   │
                                              monitoring ──────────┘
```

### 5.2 State Definitions

| State | Description |
|---|---|
| `monitoring` | Normal operation. Cron tasks running. |
| `classifying` | Anomaly received. Scoring severity. |
| `alerting_operator` | Low/Medium: alert sent, waiting up to 15 min for operator response. |
| `responding` | High/Critical: `cloudflare_kill` executed. Waiting for operator acknowledgement. |
| `awaiting_clearance` | Operator acknowledged. Waiting for CLEAR-THREAT or further instructions. |
| `recovering` | Operator approved restart. Restoring services. |

### 5.3 FSM Definition (sam-fsm)

```typescript
import { fsm } from 'sam-fsm'

const escalationFSM = fsm({
  pc: 'incidentState',
  pc0: 'monitoring',

  transitions: [
    { from: 'monitoring',          to: 'classifying',        on: 'ANOMALY_DETECTED' },
    { from: 'classifying',         to: 'monitoring',         on: 'FALSE_POSITIVE' },
    { from: 'classifying',         to: 'alerting_operator',  on: 'CLASSIFY_LOW' },
    { from: 'classifying',         to: 'alerting_operator',  on: 'CLASSIFY_MEDIUM' },
    { from: 'classifying',         to: 'responding',         on: 'CLASSIFY_HIGH' },
    { from: 'classifying',         to: 'responding',         on: 'CLASSIFY_CRITICAL' },
    { from: 'alerting_operator',   to: 'monitoring',         on: 'OPERATOR_CLEARED' },
    { from: 'alerting_operator',   to: 'responding',         on: 'OPERATOR_ESCALATED' },
    { from: 'alerting_operator',   to: 'responding',         on: 'ALERT_TIMEOUT' },
    { from: 'responding',          to: 'awaiting_clearance', on: 'OPERATOR_ACKNOWLEDGED' },
    { from: 'awaiting_clearance',  to: 'recovering',         on: 'CLEAR_THREAT' },
    { from: 'awaiting_clearance',  to: 'monitoring',         on: 'THREAT_CONFIRMED_CONTAINED' },
    { from: 'recovering',          to: 'monitoring',         on: 'HEALTH_CHECK_PASS' },
    { from: 'recovering',          to: 'awaiting_clearance', on: 'HEALTH_CHECK_FAIL' },
  ],

  deterministic: true,
  enforceAllowedTransitions: true,

  states: {
    classifying: {
      naps: [{
        condition: () => true,
        nextAction: (state) => classifyAnomalyAndTransition(state.anomalyReport)
      }]
    },
    responding: {
      naps: [{
        condition: (state) => !state.cloudflarKilled,
        nextAction: (state) => executeCloudflareKill(state.incidentId)
      }, {
        condition: (state) => state.cloudflareKilled && !state.operatorAlerted,
        nextAction: (state) => sendCriticalAlert(state.incidentId)
      }]
    },
    alerting_operator: {
      naps: [{
        condition: (state) => !state.alertSent,
        nextAction: (state) => sendSecurityAlert(state.incidentId, state.severity)
      }, {
        condition: (state) => state.alertSent && minutesSince(state.alertSentAt) >= 15,
        nextAction: (state) => triggerAlertTimeout(state.incidentId)
      }]
    },
    recovering: {
      naps: [{
        condition: (state) => !state.cloudflareRestarted,
        nextAction: (state) => restartCloudflare(state.incidentId)
      }, {
        condition: (state) => state.cloudflareRestarted,
        nextAction: (state) => runHealthCheckAfterRecovery(state.incidentId)
      }]
    }
  }
})
```

### 5.4 Incident Record Schema

All incidents are persisted to `session.db` with full context:

```sql
CREATE TABLE security_incidents (
  id TEXT PRIMARY KEY,              -- uuid
  detected_at TEXT NOT NULL,
  incident_type TEXT NOT NULL,      -- 'git_audit' | 'process_monitor' | 'network_scan' | 'access_log'
  severity TEXT NOT NULL,           -- 'low' | 'medium' | 'high' | 'critical'
  state TEXT NOT NULL,              -- current FSM state
  evidence TEXT NOT NULL,           -- JSON array of evidence items
  actions_taken TEXT,               -- JSON array of actions executed
  cloudflare_killed INTEGER DEFAULT 0,
  appliance_paused INTEGER DEFAULT 0,
  alert_sent_at TEXT,
  operator_acknowledged_at TEXT,
  resolved_at TEXT,
  resolution TEXT,                  -- 'false_positive' | 'threat_cleared' | 'contained'
  operator_email_thread TEXT        -- email thread id for reply matching
);
```

---

## 6. Anomaly Classifier

The classifier is a deterministic function — no LLM inference — that produces a severity score from tool outputs. LLM is only invoked to generate the human-readable incident summary.

```typescript
interface AnomalyReport {
  source: 'git_audit' | 'process_monitor' | 'network_scan' | 'access_log_scan'
  findings: Finding[]
}

function classifyAnomaly(report: AnomalyReport): Severity {
  const scores = report.findings.map(f => f.severity)

  // Escalate to highest severity present
  if (scores.includes('critical')) return 'critical'
  if (scores.includes('high')) return 'high'
  if (scores.includes('medium')) return 'medium'
  if (scores.includes('low')) return 'low'
  return 'clean'
}
```

**Severity escalation rules:**

| Tool | Finding | Severity |
|---|---|---|
| git_audit | Force push on main | high |
| git_audit | Unknown author commit | medium |
| process_monitor | Unknown process with open port | high |
| process_monitor | Unknown binary executing as root | critical |
| network_scan | Unknown MAC on network | medium |
| network_scan | Unknown device connecting to port 3000 | high |
| access_log_scan | SSH brute force (>5 fails/5min) | high |
| access_log_scan | SQLi pattern in request | high |
| access_log_scan | Scanner user agent | medium |
| credential_audit | Secret pattern found in git | high |
| credential_audit | .env not in .gitignore | medium |

**False positive patterns (known-safe, logged but not escalated):**
- Bun process restarting by pm2 (creates duplicate PID briefly)
- Let's Encrypt cert renewal process (runs as root briefly)
- COSA Pi itself appearing in network scan

---

## 7. Encrypted Credential Store

### 7.1 Design

All credentials are stored in an AES-256-GCM encrypted SQLite database on the COSA Pi. The encryption key is derived from an environment variable (`COSA_CREDENTIAL_KEY`), never stored on disk.

```
~/.cosa/
├── credentials.enc.db     # encrypted SQLite
├── tirith                 # Tirith binary
├── tirith.yaml            # Tirith config
└── config.yaml            # COSA config (no secrets)
```

**Credential table (inside encrypted DB):**
```sql
CREATE TABLE credentials (
  name TEXT PRIMARY KEY,        -- symbolic name (e.g., "clover_api_key")
  value TEXT NOT NULL,          -- encrypted value (AES-256-GCM)
  created_at TEXT NOT NULL,
  last_accessed TEXT,
  last_rotated TEXT,
  rotation_due_days INTEGER DEFAULT 90,
  notes TEXT
);
```

### 7.2 Access Pattern

```typescript
class CredentialStore {
  private db: Database

  constructor(keyFromEnv: string) {
    // Key derivation: PBKDF2-SHA256, 100k iterations, 32-byte output
    const key = deriveKey(keyFromEnv, FIXED_SALT)
    this.db = openEncryptedDb('~/.cosa/credentials.enc.db', key)
  }

  get(name: string): string {
    const row = this.db.query('SELECT value FROM credentials WHERE name = ?').get(name)
    if (!row) throw new Error(`Credential not found: ${name}`)
    this.db.run('UPDATE credentials SET last_accessed = ? WHERE name = ?',
      [new Date().toISOString(), name])
    return decrypt(row.value, this.key)
  }

  // Credentials are NEVER passed to:
  // - Tool outputs (output sanitizer strips them)
  // - SSH commands (never interpolated in shell commands)
  // - session.db (only symbolic names are logged)
  // - Claude Code sessions (not accessible from Baanbaan Pi)
}
```

### 7.3 Output Sanitizer

Runs on every tool output before it enters the conversation context:

```typescript
const CREDENTIAL_PATTERNS = [
  /sk_live_[a-zA-Z0-9]{24,}/g,       // Clover live key pattern
  /AKIA[0-9A-Z]{16}/g,                // AWS access key
  /[a-zA-Z0-9+/]{40}={0,2}/g,        // Base64 encoded secrets (40+ chars)
  /password["'\s]*[:=]["'\s]*\S{8,}/gi,
  /token["'\s]*[:=]["'\s]*\S{16,}/gi,
]

function sanitizeOutput(output: string): string {
  let sanitized = output
  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return sanitized
}
```

---

## 8. Cron Schedule Additions (Phase 3)

These are added to the existing Phase 2 cron schedule:

| Frequency | Task | Tools Used | Output |
|---|---|---|---|
| Every 6h | Git audit | `git_audit` | Alert if severity ≥ medium |
| Every 6h | Process monitor | `process_monitor` | Alert if severity ≥ medium |
| Every 6h | Network scan | `network_scan` | Alert if unknown device |
| Every 6h | Access log scan | `access_log_scan` | Alert if severity ≥ medium |
| Weekly Mon 2:00 AM | Security digest | All SECURE Read tools | Email weekly digest |
| Weekly Mon 2:00 AM | Credential audit | `credential_audit` | Alert if finding |
| Weekly Mon 2:00 AM | Compliance verify | `compliance_verify` | Include in weekly digest |
| Weekly Mon 2:00 AM | Webhook HMAC verify | `webhook_hmac_verify` | Alert if HMAC inactive (critical) |
| Weekly Mon 2:00 AM | JWT secret check | `jwt_secret_check` | Remind if > 90 days |
| Monthly 1st 2:00 AM | PCI self-assessment | `pci_assessment` | Email full report |
| Monthly 1st 2:00 AM | Token rotation remind | `token_rotation_remind` | Email if rotation due |

**Weekly Security Digest format:**
```
Subject: [COSA] Weekly Security Digest — {appliance_name} — {date}

Git Audit (last 7 days):
  ✓ All commits from expected authors (3 commits)
  ✓ No force pushes detected

Process Monitor:
  ✓ All processes match expected list

Network Scan:
  ✓ All devices in known-good inventory (4 devices)

Access Logs:
  ⚠ 12 failed login attempts from 3 different IPs (low rate, not anomalous)
  ✓ No injection patterns detected

Credential Audit:
  ✓ No exposed secrets found

Compliance Verification:
  ✓ SSH: password auth disabled, root login disabled
  ✓ HMAC validation active on webhook
  ⚠ JWT secret last rotated 78 days ago (rotation due in 12 days)

Security incidents this week: 0

Next full security scan: {next_monday}
Next PCI assessment: {next_month_1st}
```

---

## 9. Auto-Permit Policy for `cloudflare_kill` (Deferred)

**Current Phase 3 behavior:** `cloudflare_kill` uses the standard approval gate. COSA sends an email with a 5-minute response window, then auto-denies if no response.

This means a critical intrusion at 3:00 AM will not get a response for hours. This is the known trade-off: we prioritize **no false positives in production** over **instant autonomous response** until we have operational data.

**What to measure during Phase 3 (to inform the decision):**
- Number of false positives generated by the classifier over 4 weeks of operation
- Distribution of anomaly events by severity
- Average operator response time to High/Critical alerts
- Estimated time-to-impact for the most common intrusion vectors

**Decision point:** After 4 weeks of Phase 3 operation with approval-required flow, review false positive rate. If rate is <5% (fewer than 1 false positive per month), enable auto-permit for `cloudflare_kill` on Critical only. If rate is higher, refine the classifier first.

---

## 10. Test Plan and Exit Criteria

### 10.1 Unit Tests (per tool)

Each SECURE tool must have a test that:
1. Runs against a known-good Baanbaan state → returns `ok: true, severity: 'clean'`
2. Runs against a prepared anomalous state → returns correct `severity` and `findings`
3. Handles SSH connection failure gracefully (timeout, auth failure)

```typescript
// Example: process_monitor unit test
describe('process_monitor', () => {
  it('returns clean when all processes match expected list', async () => {
    const result = await processMonitor({ sshTarget: TEST_HOST, expectedProcesses: BASELINE })
    expect(result.ok).toBe(true)
    expect(result.severity).toBe('clean')
    expect(result.unknownProcesses).toHaveLength(0)
  })

  it('detects unknown process and classifies as medium severity', async () => {
    // inject unknown process into test environment
    const result = await processMonitor({ sshTarget: TEST_HOST_WITH_UNKNOWN, expectedProcesses: BASELINE })
    expect(result.ok).toBe(false)
    expect(result.severity).toBe('medium')
    expect(result.unknownProcesses.length).toBeGreaterThan(0)
  })
})
```

### 10.2 Escalation FSM Tests

```typescript
describe('escalation FSM', () => {
  it('transitions from monitoring → classifying → alerting_operator on medium anomaly', ...)
  it('transitions from monitoring → classifying → responding on high anomaly', ...)
  it('NAP: sends cloudflare_kill immediately on entering responding state', ...)
  it('NAP: sends alert email within 1 second of cloudflare_kill', ...)
  it('transitions from responding → awaiting_clearance on OPERATOR_ACKNOWLEDGED', ...)
  it('transitions from awaiting_clearance → recovering on CLEAR_THREAT', ...)
  it('transitions from recovering → monitoring when health_check passes', ...)
})
```

### 10.3 Credential Store Tests

```typescript
describe('credential_store', () => {
  it('retrieves a credential by symbolic name', ...)
  it('throws if credential not found', ...)
  it('logs last_accessed timestamp on retrieval', ...)
  it('never returns credential in plaintext through output sanitizer', ...)
})

describe('output_sanitizer', () => {
  it('redacts Clover API key pattern from output string', ...)
  it('redacts AWS key pattern from output string', ...)
  it('passes clean output unchanged', ...)
})
```

### 10.4 Integration Test: Simulated Intrusion

This is the Phase 3 exit criterion test.

**Setup:**
1. COSA running and connected to Baanbaan Pi
2. Phase 2 cron tasks disabled for test duration
3. Operator email monitoring active

**Test execution:**
```bash
# On Baanbaan Pi (simulating brute force from test IP):
for i in {1..10}; do
  ssh -o StrictHostKeyChecking=no baduser@127.0.0.1 2>/dev/null || true
done
```

**Expected sequence and timing:**

| Step | Expected | Timeout |
|---|---|---|
| 1 | `access_log_scan` detects brute force pattern | < 5 min (next cron tick) |
| 2 | Classifier returns `severity: 'high'` | < 5 sec |
| 3 | Escalation FSM enters `responding` | < 5 sec |
| 4 | `cloudflare_kill` NAP executes | < 30 sec |
| 5 | `cloudflare_kill` returns `success: true` | < 15 sec |
| 6 | Alert email sent to operator | < 30 sec |
| 7 | Operator replies `CLEAR-THREAT-{token}` | manual |
| 8 | FSM enters `recovering` | < 30 sec of reply |
| 9 | `cloudflared` service restarted | < 30 sec |
| 10 | Health check passes | < 60 sec |
| 11 | FSM returns to `monitoring` | < 5 sec |
| 12 | Confirmation email sent to operator | < 30 sec |

**Pass criteria for Phase 3 exit:**
- [ ] Steps 1–6 complete autonomously (no human action)
- [ ] Total time from attack simulation to alert email: < 10 minutes
- [ ] Alert email contains: attack evidence, IP address, actions taken, response instructions
- [ ] CLEAR-THREAT reply correctly parsed and FSM advances
- [ ] Cloudflare tunnel confirmed killed and restarted
- [ ] Full incident recorded in session.db with all steps logged
- [ ] No credentials appear in any log or email

### 10.5 Regression Test: No False Positives on Clean State

Run all SECURE tools against a clean Baanbaan state (after simulated intrusion test is reset):

```bash
cosa secure-scan --all --expect-clean
```

- All tools must return `severity: 'clean'`
- No alerts must be sent
- No escalation FSM transitions must trigger

---

## 11. Implementation Sequence

Build and test in this order to ensure each layer is validated before the next depends on it:

1. **Credential store** — foundational; everything else needs it
2. **Output sanitizer** — foundational; protects all subsequent tool outputs
3. **Tirith integration** — integrates into existing tool gate
4. **`git_audit`** — simplest read tool; validates SSH baseline
5. **`process_monitor`** — validates process scanning
6. **`network_scan`** — validates network baseline
7. **`access_log_scan`** — validates log parsing
8. **Anomaly classifier** — aggregates all four scan tools
9. **`ips_alert`** — prerequisite for escalation FSM
10. **`cloudflare_kill`** — test with approval gate first
11. **`pause_appliance`** — same as above
12. **Escalation FSM** — integrates all the above
13. **`credential_audit`** — standalone weekly tool
14. **`compliance_verify`** — standalone weekly tool
15. **`pci_assessment`** — standalone monthly tool
16. **`jwt_secret_check`** + **`webhook_hmac_verify`** + **`token_rotation_remind`** — standalone monthly tools
17. **Cron schedule additions** — wire all tools into scheduler
18. **Weekly security digest** — aggregates all scan results
19. **Integration test: simulated intrusion** — Phase 3 exit criteria

---

*Phase 3 specification complete. Implementation may begin once Phase 2 exit criteria are verified.*
