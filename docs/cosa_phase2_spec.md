# COSA Phase 2: Technical and Functional Specification

**Version:** 0.1
**Date:** 2026-03-29
**Branch:** main
**Status:** Phase 2 Specification — Draft

---

## 0. Purpose and Scope

This document is the implementation-level specification for **COSA Phase 2 — Operate**. It translates the Phase 2 roadmap in `cosa-architecture-proposal.md` and the behaviors described in `cosa_functional_spec.md` into concrete schemas, module contracts, interaction protocols, and acceptance tests.

**Phase 1 exit criteria (already met):**
> COSA can answer "is Baanbaan healthy?" autonomously, alert the operator by email if not, and accept email replies as approval tokens.

**Phase 2 exit criteria:**
> COSA runs the nightly backup, produces daily shift reports delivered by email, and creates skills from novel incidents — all without human intervention.

**What is in scope for Phase 2:**

- Full OPERATE tool set (9 new tools)
- MEMORY.md local memory system (load, update, enforce size limit)
- Skill library (`skills.db`): schema, 8 seed skills, skill creation workflow
- Layered prompt architecture with Anthropic prompt caching
- Context compression (summarize middle turns when approaching context limit)
- Full cron schedule (backup, reporting, archive check)
- Email activity reports (daily shift report, weekly digest)
- CLI interface (interactive local conversation mode)
- `session.db` FTS5 cross-session search exposed to the agent

**What is explicitly out of scope for Phase 2:**

- SECURE domain tools (Phase 3)
- CODE domain tools (Phase 4)
- Honcho AI-native memory (Phase 5)
- Multi-appliance design (Phase 5)
- Baanbaan POS-specific tool implementations — Phase 2 tools are implemented against the WeatherStation mock; Baanbaan-specific adapters are noted in §6.4

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     COSA Process (COSA Pi)                  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Email Gateway│  │Cron Scheduler│  │ CLI Interface      │ │
│  │ (IMAP + SMTP)│  │(full schedule│  │ (interactive mode) │ │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘ │
│         └─────────────────┼──────────────────┘             │
│                           │                                 │
│              ┌────────────▼────────────┐                    │
│              │       Orchestrator      │                    │
│              │    (core agent loop)    │                    │
│              └────────────┬────────────┘                    │
│                           │                                 │
│    ┌──────────────────────┼─────────────────────────┐       │
│    │                      │                         │       │
│  ┌─▼──────────┐  ┌────────▼───────┐  ┌─────────────▼────┐  │
│  │  Security  │  │Approval Engine │  │  Tool Registry   │  │
│  │  Gate      │  │                │  │                  │  │
│  └────────────┘  └────────────────┘  └────────┬─────────┘  │
│                                               │            │
│  ┌──────────────────────────────────────────┐ │            │
│  │           Memory Layer                   │ │            │
│  │  MemoryManager · SkillStore ·             │ │            │
│  │  ContextBuilder · ContextCompressor      │ │            │
│  └──────────────────────────────────────────┘ │            │
│                                               │            │
│  ┌──────────────────────────────────────────┐ │            │
│  │           Datastores                     │ │            │
│  │  session.db · skills.db · MEMORY.md      │ │            │
│  └──────────────────────────────────────────┘ │            │
│                                               │            │
│                                      ┌────────▼─────────┐  │
│                                      │  SSH Backend     │  │
│                                      └────────┬─────────┘  │
└───────────────────────────────────────────────┼────────────┘
                                                │ SSH
                                       ┌────────▼──────────┐
                                       │  Appliance        │
                                       │  (WeatherStation  │
                                       │   / Baanbaan)     │
                                       └───────────────────┘
```

---

## 2. Module Breakdown

### 2.1 Directory Structure (Phase 2 additions)

```
cosa/
├── src/
│   ├── main.js                     # Updated: CLI startup, new cron tasks
│   ├── orchestrator.js             # Updated: context compression, skill post-hook
│   ├── context-builder.js          # Updated: full 10-layer prompt, cache hints
│   ├── session-store.js            # Updated: archive_search FTS5 API
│   ├── memory-manager.js           # NEW: MEMORY.md load, update, enforce limit
│   ├── skill-store.js              # NEW: skills.db CRUD, seed install, creation FSM
│   ├── context-compressor.js       # NEW: detect threshold, summarize, reattach
│   ├── cli.js                      # NEW: local interactive conversation REPL
│   ├── tool-registry.js            # Updated: register Phase 2 tools
│   ├── approval-engine.js          # No change
│   ├── security-gate.js            # No change
│   ├── ssh-backend.js              # No change
│   ├── email-gateway.js            # No change
│   ├── cron-scheduler.js           # Updated: full schedule
│   └── tools/
│       ├── health-check.js         # No change
│       ├── db-query.js             # No change
│       ├── db-integrity.js         # No change
│       ├── shift-report.js         # NEW
│       ├── archive-search.js       # NEW
│       ├── backup-run.js           # NEW
│       ├── backup-verify.js        # NEW
│       ├── settings-write.js       # NEW
│       ├── restart-appliance.js    # NEW
│       └── session-search.js       # NEW (exposes FTS5 to agent)
├── config/
│   ├── appliance.yaml              # Updated: backup, cron, Phase 2 tool config
│   ├── cosa.config.js              # Updated: Phase 2 config fields
│   ├── APPLIANCE.md                # Updated: COSA updates this autonomously
│   └── OPERATIONS.md               # NEW: Learned operational patterns (agent-writable)
├── data/
│   ├── session.db                  # Updated: parent_id FTS5 active in Phase 2
│   ├── skills.db                   # NEW: skill library
│   └── MEMORY.md                   # NEW: short-form persistent memory
├── skills/
│   └── seed/                       # NEW: 8 seed skill markdown files
│       ├── weather-readings-missing.md
│       ├── station-offline-recovery.md
│       ├── nightly-backup-verify.md
│       ├── db-integrity-failure.md
│       ├── ssh-connectivity-lost.md
│       ├── shift-report-generation.md
│       ├── settings-correction.md
│       └── service-restart-safe.md
└── test/
    └── phase2/                     # NEW: Phase 2 integration tests
```

### 2.2 New Module Responsibilities

| Module | Responsibility |
|---|---|
| `memory-manager.js` | Load `MEMORY.md` at session start; provide `update(patch)` to merge new facts; enforce ≤2200 char hard limit via oldest-entry pruning |
| `skill-store.js` | Open/initialize `skills.db`; install seed skills on first run; expose `list()`, `get(name)`, `create(skill)`, `improve(name, experience)` |
| `context-compressor.js` | Inspect message array length; when token estimate exceeds threshold, call Haiku to summarize middle turns; splice summary back in; record parent session link |
| `cli.js` | Start a readline REPL loop; pipe each line to `runSession({ type: 'cli', source: 'cli', message })`; print response; Ctrl+C exits cleanly |
| `shift-report.js` | Aggregate the previous day's appliance records into a plain-text summary; return structured data |
| `archive-search.js` | FTS5 query against historical records (JSONL or db); enforce off-hours gate (only available outside 10am–10pm local time) |
| `backup-run.js` | Trigger the appliance backup procedure; return job ID or success/failure |
| `backup-verify.js` | Verify the most recent backup's checksum and completeness; return structured pass/fail |
| `settings-write.js` | Update a single appliance config key-value; requires `medium` risk approval |
| `restart-appliance.js` | Issue a graceful service restart via process supervisor; requires `high` risk approval |
| `session-search.js` | Expose `turns_fts` full-text search to the agent; returns matching turns with session context |

---

## 3. Data Schema

### 3.1 `session.db` — Phase 2 additions

No new tables are required. The `parent_id` column on `sessions` (already defined in Phase 1 schema) becomes active in Phase 2 for context compression continuity.

**FTS5 trigger maintenance** — The `turns_fts` virtual table is a content-rowid table (`content=turns`). It does not auto-update on INSERT; triggers must be added to keep it in sync:

```sql
-- Add to runMigrations() in session-store.js
CREATE TRIGGER IF NOT EXISTS turns_fts_insert
  AFTER INSERT ON turns
BEGIN
  INSERT INTO turns_fts(rowid, content, session_id, turn_index, created_at)
  VALUES (new.id, new.content, new.session_id, new.turn_index, new.created_at);
END;

CREATE TRIGGER IF NOT EXISTS turns_fts_delete
  AFTER DELETE ON turns
BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content, session_id, turn_index, created_at)
  VALUES ('delete', old.id, old.content, old.session_id, old.turn_index, old.created_at);
END;

CREATE TRIGGER IF NOT EXISTS turns_fts_update
  AFTER UPDATE ON turns
BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content, session_id, turn_index, created_at)
  VALUES ('delete', old.id, old.content, old.session_id, old.turn_index, old.created_at);
  INSERT INTO turns_fts(rowid, content, session_id, turn_index, created_at)
  VALUES (new.id, new.content, new.session_id, new.turn_index, new.created_at);
END;
```

**New `session-store.js` export:**

```javascript
/**
 * Full-text search across all session turns.
 *
 * @param {string} query - FTS5 match expression (e.g. "backup failed")
 * @param {number} [limit=10]
 * @returns {Array<{ session_id, turn_index, role, content, created_at, rank }>}
 */
function searchTurns(query, limit = 10) {
  return getDb()
    .prepare(
      `SELECT t.session_id, t.turn_index, t.role, t.content, t.created_at,
              turns_fts.rank
       FROM turns_fts
       JOIN turns t ON turns_fts.rowid = t.id
       WHERE turns_fts MATCH ?
       ORDER BY turns_fts.rank
       LIMIT ?`
    )
    .all(query, limit);
}
```

### 3.2 `skills.db`

New SQLite database at `data/skills.db`. WAL mode. Created and migrated by `skill-store.js`.

```sql
CREATE TABLE IF NOT EXISTS skills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,   -- slug, e.g. "station-offline-recovery"
  title        TEXT NOT NULL,           -- human-readable title
  description  TEXT NOT NULL,           -- one-paragraph summary (~200 chars)
  domain       TEXT NOT NULL,           -- 'operate' | 'secure' | 'code'
  content      TEXT NOT NULL,           -- full skill markdown document
  version      INTEGER NOT NULL DEFAULT 1,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,                    -- ISO 8601
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_name   ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);

-- FTS5 index for skill discovery
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name        UNINDEXED,
  title,
  description,
  content,
  content=skills,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS skills_fts_insert
  AFTER INSERT ON skills
BEGIN
  INSERT INTO skills_fts(rowid, name, title, description, content)
  VALUES (new.id, new.name, new.title, new.description, new.content);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_update
  AFTER UPDATE ON skills
BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, title, description, content)
  VALUES ('delete', old.id, old.name, old.title, old.description, old.content);
  INSERT INTO skills_fts(rowid, name, title, description, content)
  VALUES (new.id, new.name, new.title, new.description, new.content);
END;

CREATE TABLE IF NOT EXISTS skill_uses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name  TEXT NOT NULL REFERENCES skills(name),
  session_id  TEXT NOT NULL,
  outcome     TEXT NOT NULL,   -- 'success' | 'partial' | 'failure'
  deviation   TEXT,            -- what differed from the skill procedure
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_uses_name ON skill_uses(skill_name);
```

### 3.3 `data/MEMORY.md`

Plain text file. Created on first COSA run if absent. Updated in-place by `memory-manager.js` after each significant operation. Hard limit: **2200 characters**.

**Schema (sections are delimiters, not headers — agent writes free text within each):**

```markdown
<!-- COSA MEMORY — last updated: {ISO timestamp} -->

## Appliance Health
{One paragraph. Current overall state, last known healthy timestamp, any active degradation.}

## Recent Incidents
{Bullet list of up to 5 most recent notable incidents. Each: date, event, resolution.}
- {date}: {event} — {resolution}

## Active Anomalies
{Any ongoing issues that have not been fully resolved. "None." if clean.}

## Operator Preferences
{Known operator preferences inferred from approvals, denials, notes. Free text.}

## Last Backup
{Date, outcome, checksum status.}

## Notes
{Any other persistent facts COSA should remember. Free text. Keep short.}
<!-- END MEMORY -->
```

**Enforcement rule:** If a proposed update would push the file over 2200 characters, `memory-manager.js` trims the **Recent Incidents** section to 3 entries (oldest removed) and retries. If still over limit after trimming, the **Notes** section is truncated to 100 characters. The hard limit is never exceeded.

---

## 4. Configuration Schema (Phase 2 additions)

### 4.1 `config/appliance.yaml` additions

```yaml
# --- Phase 2 additions below Phase 1 config ---

backup:
  enabled: true
  # For WeatherStation: export readings to a local JSONL file
  # For Baanbaan: S3 bucket + JSONL cold archive
  target: "local"                         # 'local' | 's3'
  local_path: "/tmp/cosa-backups"         # local target directory (dev)
  # s3_bucket: "baanbaan-backups"         # Baanbaan production
  # s3_prefix: "appliance/"
  checksum_algorithm: "sha256"
  verify_after_run: true                  # auto-verify immediately after backup

reporting:
  shift_report_hour: 6                    # send shift report at 6:00 AM local time
  shift_report_lookback_hours: 24         # cover the previous 24 hours
  timezone: "America/New_York"            # used by cron and report timestamps

memory:
  path: "./data/MEMORY.md"
  max_chars: 2200

skills:
  db_path: "./data/skills.db"
  seed_dir: "./skills/seed"
  auto_create: true                       # create skill from novel incidents
  min_tool_calls_for_skill: 2             # create skill if resolution took >= this many calls

context_compression:
  enabled: true
  max_turns_before_compress: 12           # compress when message array exceeds this
  protect_first_n: 3
  protect_last_n: 4
  compression_model: "claude-haiku-4-5-20251001"

cron:
  health_check:      "0 * * * *"          # every hour
  backup:            "0 3 * * *"          # daily 3:00 AM
  backup_verify:     "5 3 * * *"          # daily 3:05 AM (after backup)
  shift_report:      "0 6 * * *"          # daily 6:00 AM
  archive_check:     "10 3 * * *"         # daily 3:10 AM
  weekly_digest:     "0 2 * * 1"          # Monday 2:00 AM

tools:
  # Phase 1 tools unchanged
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

  # Phase 2 tools
  shift_report:
    enabled: true
    lookback_hours: 24
  archive_search:
    enabled: true
    off_hours_gate: true                  # only allowed outside 10am–10pm
    max_results: 50
  backup_run:
    enabled: true
    timeout_ms: 120000
  backup_verify:
    enabled: true
    timeout_ms: 30000
  settings_write:
    enabled: true
    allowed_keys:                         # allowlist — only these keys can be set
      - "station.location"
      - "station.altitude_m"
      - "fetch.interval_minutes"
  restart_appliance:
    enabled: true
    graceful_timeout_seconds: 30
  session_search:
    enabled: true
    max_results: 10
```

### 4.2 `config/OPERATIONS.md`

New agent-writable context file. Included in the system prompt at Layer 2. COSA updates this file autonomously when it discovers new operational patterns. Operators may also edit it directly.

Seed content for WeatherStation:

```markdown
# WeatherStation — Operational Patterns

## Normal Behavior
- Weather readings arrive every ~30 minutes from Open-Meteo.
- SSH health check should always succeed; the station runs continuously.
- Database contains `readings` table (id, timestamp, temp_c, humidity, wind_kmh, condition, wmo_code).
- Database contains `station_info` table (key, value) for configuration.

## Known Issues
(COSA will append discovered patterns here.)

## Escalation Notes
- Restart is safe at any time; the station is stateless between readings.
- Settings changes take effect on the next reading cycle.
```

---

## 5. Layered Prompt Architecture

### 5.1 Ten-Layer System Prompt

The context builder assembles the system prompt as ten layers. Layers 0–4 are frozen at session start (cache-hit on Anthropic API). Layers 5–9 change per turn.

```
Layer 0 │ COSA core identity (static — same across all appliances)
Layer 1 │ Appliance identity: config/APPLIANCE.md
Layer 2 │ Operational patterns: config/OPERATIONS.md
Layer 3 │ Skill index: compact list (~30 tokens/skill) from skills.db
Layer 4 │ MEMORY.md snapshot (loaded once at session start)
─────── │ ─── cache boundary ───────────────────────────────────────
Layer 5 │ Active skill detail: full document for the matched skill(s)
Layer 6 │ Tool registry: schemas for domain-filtered enabled tools
Layer 7 │ Session context summary (compressed middle turns, if any)
Layer 8 │ Cross-session recall: turns from session_search (if relevant)
Layer 9 │ Current message / cron trigger / alert payload + timestamp
```

Layers 0–4 are concatenated as a single `system` block in the first API call of each session. They are never modified within the session — this guarantees a prompt cache hit for all subsequent turns.

Layers 5–9 are assembled fresh each turn and appended as the first `user` message preamble, or injected into the system prompt's mutable section for models that support it.

**Implementation note:** The Anthropic API supports caching by designating cache breakpoints in the `system` array. Layers 0–4 are sent as a single system block with `cache_control: { type: "ephemeral" }`. This provides the ~90% token discount on the repeated prefix.

### 5.2 `context-builder.js` updated API

```javascript
/**
 * Assemble the full layered system prompt for a session.
 *
 * @param {{
 *   memory?:      string,   // MEMORY.md contents (Layer 4)
 *   skillIndex?:  string,   // compact skill list (Layer 3)
 *   activeSkills?: string[], // full skill docs to include (Layer 5)
 *   sessionSummary?: string, // compressed context summary (Layer 7)
 * }} options
 * @returns {{ system: Array<{type:'text', text:string, cache_control?:object}> }}
 */
function build(options = {}) { ... }
```

The return value is an array suitable for direct use as the `system` parameter of `client.messages.create()`.

---

## 6. New Tools — OPERATE Domain

All Phase 2 tools are implemented against the WeatherStation mock. Each tool documents its Baanbaan mapping in a comment block (§6.4).

### 6.1 `shift_report`

**Description:** Aggregates appliance records from the past N hours into a structured summary. For WeatherStation: daily weather summary (min/max/avg temperature, dominant condition, total readings). For Baanbaan: daily sales summary.

**Risk level:** `read`

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "lookback_hours": {
      "type": "integer",
      "description": "Number of hours to look back from now. Default: 24.",
      "minimum": 1,
      "maximum": 48,
      "default": 24
    },
    "date": {
      "type": "string",
      "description": "ISO 8601 date (YYYY-MM-DD) to report on. Overrides lookback_hours when provided."
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "period_start": "2026-03-28T06:00:00.000Z",
  "period_end":   "2026-03-29T06:00:00.000Z",
  "total_readings": 48,
  "temperature": {
    "min_c":  4.2,
    "max_c":  14.7,
    "avg_c":  9.1
  },
  "humidity": {
    "avg_pct": 73
  },
  "conditions": [
    { "label": "Partly cloudy", "count": 22 },
    { "label": "Clear sky",     "count": 14 },
    { "label": "Overcast",      "count": 12 }
  ],
  "anomalies": []
}
```

**SSH query (WeatherStation):**

```sql
SELECT
  MIN(temp_c) AS min_c,
  MAX(temp_c) AS max_c,
  ROUND(AVG(temp_c), 1) AS avg_c,
  ROUND(AVG(humidity), 0) AS avg_humidity,
  COUNT(*) AS total,
  condition,
  COUNT(*) AS cond_count
FROM readings
WHERE timestamp >= ? AND timestamp < ?
GROUP BY condition
ORDER BY cond_count DESC;
```

Executed via `db_query` tool (already implemented). `shift_report.js` calls the tool internally and formats the result.

### 6.2 `archive_search`

**Description:** Full-text search across historical session turns. Delegates to `session-store.searchTurns()`. Used by COSA to recall prior incidents, not to query appliance data.

**Risk level:** `read`

**Off-hours gate:** Disabled in this implementation (the gate is a Baanbaan-specific concern). The `off_hours_gate` config key is parsed but defaults to `false` for WeatherStation.

**Input schema:**

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "description": "FTS5 match expression. Example: \"backup failed\" or \"temperature anomaly\".",
      "minLength": 2,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "description": "Maximum results to return. Default: 10.",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "results": [
    {
      "session_id": "uuid",
      "turn_index": 3,
      "role": "assistant",
      "created_at": "2026-03-28T03:01:44.000Z",
      "excerpt": "...relevant content excerpt (200 chars max)..."
    }
  ],
  "total_found": 2
}
```

### 6.3 `backup_run`

**Description:** Triggers a backup of the appliance database. For WeatherStation: exports the `readings` table to a timestamped JSONL file in the configured backup directory. Records the backup path and SHA-256 checksum.

**Risk level:** `medium`

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "note": {
      "type": "string",
      "description": "Optional operator note recorded with the backup.",
      "maxLength": 200
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "success":      true,
  "backup_path":  "/tmp/cosa-backups/readings-2026-03-29T03-00-00.jsonl",
  "row_count":    2304,
  "checksum":     "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "started_at":   "2026-03-29T03:00:01.000Z",
  "completed_at": "2026-03-29T03:00:04.211Z",
  "duration_ms":  3211
}
```

**Implementation (WeatherStation):**

1. Execute `sqlite3 -json {db_path} "SELECT * FROM readings ORDER BY timestamp;"` via SSH.
2. Stream output, write each row as a JSONL line to the local backup file.
3. Compute SHA-256 of the written file.
4. Write a sidecar `.sha256` file alongside the JSONL.
5. Return structured result.

### 6.4 `backup_verify`

**Description:** Reads the most recent backup file and its sidecar checksum; re-computes the checksum; compares. Returns pass/fail with details.

**Risk level:** `read`

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "backup_path": {
      "type": "string",
      "description": "Explicit path to verify. If omitted, the most recent backup in the configured directory is used."
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "verified":      true,
  "backup_path":   "/tmp/cosa-backups/readings-2026-03-29T03-00-00.jsonl",
  "expected_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "actual_hash":   "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "row_count":     2304,
  "file_size_kb":  187,
  "backup_age_hours": 0.08
}
```

### 6.5 `settings_write`

**Description:** Updates a single appliance configuration key-value. Only keys in the `allowed_keys` allowlist (from `appliance.yaml`) may be set. Requires medium-risk approval.

**Risk level:** `medium`

**Input schema:**

```json
{
  "type": "object",
  "required": ["key", "value"],
  "properties": {
    "key": {
      "type": "string",
      "description": "Configuration key to set. Must be in the allowed_keys allowlist.",
      "maxLength": 100
    },
    "value": {
      "type": "string",
      "description": "New value for the key.",
      "maxLength": 500
    },
    "reason": {
      "type": "string",
      "description": "Human-readable reason for the change (included in approval request).",
      "maxLength": 200
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "success":    true,
  "key":        "fetch.interval_minutes",
  "old_value":  "30",
  "new_value":  "60",
  "applied_at": "2026-03-29T10:00:03.000Z"
}
```

**Implementation (WeatherStation):**

1. Validate `key` is in the `allowed_keys` allowlist; reject if not.
2. Execute `sqlite3 {db_path} "INSERT OR REPLACE INTO station_info(key,value) VALUES(?,?);"` with key and value via SSH (uses parameterized stdin approach from `db-query.js`).
3. Read back the old value before writing; include in response.

### 6.6 `restart_appliance`

**Description:** Issues a graceful service restart via the configured process supervisor. Waits for the service to come back up and confirms health before returning. Requires high-risk approval.

**Risk level:** `high`

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "description": "Human-readable reason for the restart (included in approval request).",
      "maxLength": 200
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "success":         true,
  "service_name":    "weather-station",
  "restart_issued_at": "2026-03-29T10:00:05.000Z",
  "came_up_at":      "2026-03-29T10:00:12.000Z",
  "uptime_before_ms": 3600000,
  "health_after":    "healthy"
}
```

**Implementation:**

1. Run `systemctl show --property=ActiveEnterTimestamp {service}` to capture uptime.
2. Run `systemctl restart {service}` via SSH.
3. Poll `GET /health/ready` every 2 seconds up to `graceful_timeout_seconds`.
4. Return structured result including whether health was confirmed.

### 6.7 `session_search`

**Description:** Full-text search across all prior COSA session turns. Allows COSA to recall past incident resolutions, prior diagnoses, or operator instructions from previous sessions.

**Risk level:** `read`

**Input schema:**

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "description": "Search terms. Supports FTS5 match syntax.",
      "minLength": 2,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "default": 10,
      "minimum": 1,
      "maximum": 50
    },
    "role": {
      "type": "string",
      "enum": ["user", "assistant", "tool"],
      "description": "Filter by turn role. Omit to search all roles."
    }
  },
  "additionalProperties": false
}
```

**Output schema:**

```json
{
  "results": [
    {
      "session_id":  "uuid",
      "started_at":  "2026-03-28T03:00:01.000Z",
      "trigger_type": "cron",
      "turn_index":  4,
      "role":        "assistant",
      "excerpt":     "The backup completed successfully with 2304 rows...",
      "created_at":  "2026-03-28T03:00:07.000Z"
    }
  ],
  "total_found": 1
}
```

### 6.4 Baanbaan Tool Mappings

When COSA is deployed against Baanbaan (not WeatherStation), the following adaptations apply. These are adapter-layer concerns; core module code does not change.

| Phase 2 Tool | WeatherStation impl | Baanbaan impl |
|---|---|---|
| `shift_report` | Aggregates `readings` table: temp/humidity stats | Aggregates `orders` table: total sales, order count, avg ticket, top items, payment methods |
| `archive_search` | Session FTS5 (same) | Session FTS5 (same) |
| `backup_run` | JSONL export to `/tmp/cosa-backups/` | JSONL cold archive + S3 upload to `s3://baanbaan-backups/appliance/` |
| `backup_verify` | SHA-256 of local JSONL | SHA-256 of JSONL + S3 ETag cross-check |
| `settings_write` | `station_info` table via sqlite3 | `appliance_meta` table or config file (per Baanbaan spec) |
| `restart_appliance` | `systemctl restart weather-station` | `systemctl restart baanbaan` + Cloudflare tunnel health check |
| `session_search` | Same | Same |

Tools from architecture proposal not implemented in Phase 2 (deferred to Phase 3 or Baanbaan-specific work):
- `order_status` — Baanbaan-specific; Phase 3
- `pos_health` — Baanbaan-specific; Phase 3
- `printer_status` — Baanbaan-specific; Phase 3
- `cache_flush` — Baanbaan-specific; Phase 3

---

## 7. Memory Manager

### 7.1 `memory-manager.js` Contract

```javascript
/**
 * Load MEMORY.md from disk. Returns empty template string if file absent.
 * Called once at session start; result is passed to context-builder as Layer 4.
 *
 * @returns {string} Full contents of MEMORY.md (≤2200 chars guaranteed)
 */
function loadMemory() { ... }

/**
 * Merge a patch object into MEMORY.md and write back to disk.
 * Enforces the 2200-char hard limit (prunes oldest incidents, then truncates Notes).
 *
 * @param {{
 *   applianceHealth?: string,
 *   recentIncident?: { date: string, event: string, resolution: string },
 *   activeAnomalies?: string,
 *   operatorPreference?: string,
 *   lastBackup?: string,
 *   notes?: string,
 * }} patch
 * @returns {void}
 */
function updateMemory(patch) { ... }

/**
 * Replace MEMORY.md entirely with a new string.
 * Used by the orchestrator's post-turn hook when COSA generates a full memory rewrite.
 * Enforces character limit before writing.
 *
 * @param {string} content
 * @returns {void}
 */
function writeMemory(content) { ... }
```

### 7.2 Memory Update Triggers

The orchestrator calls `updateMemory()` after any of the following tool outcomes:

| Event | Memory field updated |
|---|---|
| `health_check` returns `healthy` | `applianceHealth`: "Healthy as of {timestamp}" |
| `health_check` returns `degraded` or `unreachable` | `applianceHealth` + `activeAnomalies` |
| `backup_run` succeeds | `lastBackup`: "{date} — success, {N} rows, {checksum}" |
| `backup_run` fails | `lastBackup`: "{date} — FAILED: {reason}" + `activeAnomalies` |
| Novel incident resolved | `recentIncident`: append new entry |
| Operator denial with note | `operatorPreference`: append inferred preference |
| Anomaly resolved | `activeAnomalies`: clear or update |

Memory updates happen in the orchestrator's **post-turn hook**, not inside the tool itself. Tools are pure data producers; the orchestrator decides what the update means.

---

## 8. Skill Library

### 8.1 Skill Document Format

Skills use the agentskills.io markdown format. Each skill is stored as a `content` TEXT column in `skills.db`.

```markdown
# {Title}

**Slug:** {kebab-case-name}
**Domain:** operate | secure | code
**Applies when:** {one-sentence trigger description}
**Risk level:** read | medium | high

## Overview
{2–3 sentence description of what this skill covers and when to use it.}

## Steps
1. {First step — include the tool name if a tool call is involved}
2. {Second step}
3. ...

## Expected Outcomes
- **Success:** {what success looks like}
- **Failure signals:** {what to watch for that indicates something went wrong}

## Known Edge Cases
{Optional. Known deviations from the happy path.}

## Experience
{Appended by COSA after each use. Format: "Used {date}: {one-line outcome}. Deviation: {if any}."}
```

**Maximum skill document length:** 3000 characters. The `skill-store.js` enforcer trims the `## Experience` section to the 5 most recent entries if the document grows beyond this limit.

### 8.2 Skill Index (Layer 3)

The compact skill index used in Layer 3 is generated by:

```javascript
/**
 * Return a compact listing of all skills suitable for inclusion in the system prompt.
 * Target: ~30 tokens per skill.
 *
 * @returns {string} Multi-line string, one skill per line.
 */
function listCompact() {
  return getDb()
    .prepare(`SELECT name, title, description FROM skills ORDER BY name`)
    .all()
    .map(s => `- ${s.name}: ${s.title} — ${s.description}`)
    .join('\n');
}
```

### 8.3 Seed Skills (WeatherStation)

Eight seed skills are installed by `skill-store.js` on first run (`use_count = 0`). The files live in `skills/seed/`.

| Slug | Title | Applies when |
|---|---|---|
| `weather-readings-missing` | Weather Readings Gap Recovery | No new readings for >2 hours |
| `station-offline-recovery` | Station Offline Recovery | Health check returns unreachable |
| `nightly-backup-verify` | Nightly Backup Verification | Automated post-backup integrity check |
| `db-integrity-failure` | Database Integrity Failure Response | `db_integrity` reports errors |
| `ssh-connectivity-lost` | SSH Connectivity Lost | SSH handshake or auth fails |
| `shift-report-generation` | Daily Shift Report Generation | Daily 6am cron trigger |
| `settings-correction` | Appliance Settings Correction | Operator requests config change |
| `service-restart-safe` | Safe Service Restart | Restart required after config change or hang |

**Baanbaan equivalents** (for when the adapter is swapped):

| Slug | Title | Applies when |
|---|---|---|
| `printer-offline-recovery` | Receipt Printer Offline Recovery | Printer check fails |
| `stuck-order-recovery` | Stuck Order FSM Recovery | Order stuck in `pos_error` or `submitted_timeout` |
| `nightly-backup-verify` | Nightly Backup Verification | Post-backup S3 check |
| `pos-adapter-reconnect` | POS Adapter Reconnect | Clover API returning 401 or timeout |
| `git-audit-clean` | Git Audit Clean | Weekly git audit cron |
| `cloudflare-tunnel-restart` | Cloudflare Tunnel Restart | Tunnel process not running |
| `shift-report-generation` | Daily Shift Report Generation | Daily 6am cron trigger |
| `emergency-pause-and-report` | Emergency Pause and Report | Intrusion or critical anomaly |

### 8.4 Skill Creation FSM

After a session closes, the orchestrator's post-hook evaluates whether a new skill should be created.

```
Session closes
     │
     ▼
Did this session resolve an incident?
(criteria: trigger_type != 'email query',
 session involved ≥ 2 tool calls,
 status = 'complete')
     │ No → skip
     │ Yes
     ▼
Does a skill already exist for this incident type?
(search skills_fts for key terms from session summary)
     │ Yes → update existing skill's Experience section
     │ No
     ▼
Generate new skill document via Claude:
  - Input: session summary, tool call sequence, final resolution
  - Model: claude-sonnet-4-6
  - System: "You are COSA's skill librarian. Write a skill document
             in the agentskills.io format based on this incident."
     │
     ▼
Validate: slug unique, length ≤ 3000 chars, domain valid
     │
     ▼
Insert into skills.db
Log in session as: "New skill created: {slug}"
```

**Skill improvement (reuse path):**

When COSA begins a session and selects a skill (Layer 5), it records which skill was used. After the session closes, the post-hook calls `skill-store.improve(skillName, { session_id, outcome, deviation })`. The `## Experience` section of the skill document is updated. After 5+ uses, if deviation rate > 40%, the post-hook generates an updated skill body via Claude and replaces the content in `skills.db`.

---

## 9. Context Compression

### 9.1 `context-compressor.js` Contract

```javascript
/**
 * Check whether the current message array needs compression.
 * Returns true when the array length exceeds config.contextCompression.maxTurnsBeforeCompress.
 *
 * @param {Array} messages - The orchestrator's live message array
 * @returns {boolean}
 */
function needsCompression(messages) { ... }

/**
 * Compress the middle portion of the message array.
 * Protects the first `protectFirstN` and last `protectLastN` messages.
 * Summarizes the middle turns via an auxiliary Haiku call.
 * Returns a new message array with the summary spliced in.
 *
 * @param {Array} messages
 * @param {string} sessionId - Used to link parent session in session.db
 * @returns {Promise<Array>} New compressed message array
 */
async function compress(messages, sessionId) { ... }
```

### 9.2 Compression Procedure

```
messages array length > maxTurnsBeforeCompress (default: 12)
     │
     ▼
Partition:
  head = messages[0 .. protectFirstN-1]          (3 turns)
  middle = messages[protectFirstN .. -protectLastN] (middle)
  tail = messages[-protectLastN ..]               (4 turns)
     │
     ▼
Build compression prompt:
  "Summarize the following COSA agent session turns.
   Preserve: decisions made, tools called, outcomes, open questions.
   Be concise. Target: 300 words or less.
   <turns>{JSON.stringify(middle)}</turns>"
     │
     ▼
Call claude-haiku-4-5-20251001 with compression prompt
     │
     ▼
summary_message = {
  role: 'user',
  content: "[Context summary — prior turns compressed]\n\n{summary}"
}
     │
     ▼
compressed = [...head, summary_message, ...tail]
     │
     ▼
Log compression event to session.db
(turn role='system', content='Context compressed: {N} turns → 1 summary')
     │
     ▼
Return compressed array
```

**Parent session link:** When compression happens, the current session's `parent_id` is set to its own `session_id` (self-referential marker). This signals that the session has been compressed and the raw context is in `session.db` for audit.

---

## 10. Cron Schedule

### 10.1 Full Schedule

The cron scheduler in Phase 2 fires 6 distinct task types. Each is a full orchestrator session with a structured trigger message.

| Expression | Task name | Trigger message sent to orchestrator |
|---|---|---|
| `0 * * * *` | `health_check` | "Scheduled health check. Run health_check and report status. Update MEMORY.md with result. If degraded or unreachable, send alert email." |
| `0 3 * * *` | `backup` | "Scheduled nightly backup. Run backup_run. If successful, run backup_verify. Update MEMORY.md with backup status. Alert if failed." |
| `5 3 * * *` | `backup_verify` | "Verify the most recent backup. Run backup_verify and report. Alert operator if checksum mismatch or file missing." |
| `10 3 * * *` | `archive_check` | "Archive integrity check. Run session_search for any backup failure mentions in the last 7 days. Summarize and alert if pattern found." |
| `0 6 * * *` | `shift_report` | "Generate and send the daily shift report for the past 24 hours. Run shift_report, format as a plain-text email, send to operator. Subject: [COSA] Shift Report: {YYYY-MM-DD}." |
| `0 2 * * 1` | `weekly_digest` | "Generate the weekly operational digest. Summarize: backup status (7 days), health check results (7 days), any anomalies or incidents, skills created or improved. Send to operator. Subject: [COSA] Weekly Digest: week of {date}." |

### 10.2 Alert Deduplication

Unchanged from Phase 1: `findRecentAlert(category, severity, sinceIso)` prevents duplicate alerts within a 60-minute window per category+severity combination.

For the weekly digest, deduplication is extended: the digest is only sent if no digest was sent in the last 6 days (168 hours). This is enforced by checking `alerts` with `category = 'digest'` and `sent_at >= {7 days ago}`.

### 10.3 `cron-scheduler.js` Phase 2 additions

```javascript
/**
 * Build the trigger message for a named cron task.
 * Returns null if the task name is not recognized.
 *
 * @param {string} taskName
 * @returns {{ type: 'cron', source: string, message: string } | null}
 */
function buildTrigger(taskName) { ... }

/**
 * Register all Phase 2 cron tasks from appliance.yaml config.
 * Called from main.js at startup.
 */
function registerPhase2Tasks() { ... }
```

---

## 11. Email Reports

### 11.1 Daily Shift Report Format

Subject: `[COSA] Shift Report: 2026-03-29`

```
WeatherStation — Daily Shift Report
Period: 2026-03-28 06:00 → 2026-03-29 06:00 (24 hours)

SUMMARY
Total readings:  48
Temperature:     Min 4.2°C / Max 14.7°C / Avg 9.1°C
Humidity:        Avg 73%
Dominant condition: Partly cloudy (22 of 48 readings)

CONDITIONS BREAKDOWN
  Partly cloudy   22 readings  (46%)
  Clear sky       14 readings  (29%)
  Overcast        12 readings  (25%)

ANOMALIES
  None.

SYSTEM STATUS
  Last health check: Healthy (2026-03-29 05:00 UTC)
  Last backup:       Success  (2026-03-29 03:00 UTC, 2304 rows, checksum verified)

— COSA
```

For Baanbaan, the shift report substitutes weather stats with sales metrics (total revenue, order count, avg ticket, top items, payment breakdown).

### 11.2 Weekly Digest Format

Subject: `[COSA] Weekly Digest: week of 2026-03-23`

```
WeatherStation — Weekly Operational Digest
Week of 2026-03-23 to 2026-03-29

HEALTH CHECK (7 runs)
  Healthy: 7/7
  Incidents: None

BACKUPS (7 runs)
  Successful: 7/7
  Failed: 0
  Most recent: 2026-03-29 03:00, checksum verified

ANOMALIES THIS WEEK
  None.

SKILLS
  Created:  0 new skills
  Improved: 1 skill (station-offline-recovery, 1 new experience entry)

OPERATOR ACTIVITY
  Sessions this week: 3
  Approval requests issued: 0
  Approvals granted: 0

— COSA
```

---

## 12. CLI Interface

### 12.1 `cli.js` Contract

```javascript
/**
 * Start the COSA CLI REPL.
 * Reads input from stdin line-by-line.
 * Each line is dispatched as a new orchestrator session (type: 'cli').
 * Response is printed to stdout.
 * Ctrl+C or 'exit' terminates cleanly.
 */
async function startCli() { ... }
```

### 12.2 Startup

CLI is started from `main.js` when the `--cli` flag is passed or when `NODE_ENV=development` and stdin is a TTY:

```javascript
// In main.js boot():
if (process.argv.includes('--cli') || (process.env.NODE_ENV === 'development' && process.stdin.isTTY)) {
  const { startCli } = require('./cli');
  startCli();
}
```

### 12.3 Session continuity

The CLI does not maintain a persistent multi-turn session across prompts. Each line creates a new `runSession()` call. This is intentional: it matches the email interface behaviour and simplifies state. For multi-turn CLI sessions, the operator can ask COSA to search prior sessions via `session_search`.

---

## 13. Orchestrator Updates

### 13.1 Post-Turn Hook

After each `runSession()` completes, the orchestrator calls the post-turn hook:

```javascript
/**
 * Post-session hook. Called after session closes successfully.
 * Handles: memory update, skill creation check.
 *
 * @param {{ sessionId: string, trigger: object, toolCalls: object[], finalText: string }}
 */
async function postSessionHook({ sessionId, trigger, toolCalls, finalText }) {
  // 1. Update MEMORY.md based on tool outcomes
  await applyMemoryUpdates(toolCalls);

  // 2. Check skill creation criteria
  if (shouldCreateSkill({ trigger, toolCalls })) {
    await skillStore.createFromSession({ sessionId, toolCalls, finalText });
  }
}
```

### 13.2 Compression Integration

The orchestrator checks `contextCompressor.needsCompression(messages)` before each Claude API call. If compression is needed, it calls `contextCompressor.compress(messages, sessionId)` and replaces the message array in-place before the API call.

### 13.3 Memory Loading

At the start of each `runSession()`, before building the system prompt:

```javascript
const memory     = memoryManager.loadMemory();
const skillIndex = skillStore.listCompact();
const systemPrompt = contextBuilder.build({ memory, skillIndex });
```

---

## 14. Functional Scenarios

### Scenario F-9: Nightly Backup (Automated)

**Trigger:** Cron, 3:00 AM
**Input:** "Scheduled nightly backup. Run backup_run. If successful, run backup_verify. Update MEMORY.md with backup status. Alert if failed."

**Expected behavior:**
1. COSA calls `backup_run({})` — medium risk, but cron tasks for backup are pre-approved via `scope: 'always'` policy (see §14.6)
2. `backup_run` executes: exports `readings` table to JSONL, computes SHA-256, writes `.sha256` sidecar
3. COSA calls `backup_verify({})` — reads the backup, re-computes checksum, confirms match
4. COSA calls `updateMemory({ lastBackup: "2026-03-29 03:00 — success, 2304 rows, checksum verified" })`
5. Session closes; `closeSession()` records summary
6. No email sent (success path — only failures alert)

**On failure path:**
1. `backup_run` returns `{ success: false, error: "SSH command timeout" }`
2. COSA calls `updateMemory({ lastBackup: "2026-03-29 03:00 — FAILED: SSH timeout", activeAnomalies: "Backup failed overnight. Needs investigation." })`
3. COSA sends alert email: Subject `[COSA] Alert: WeatherStation — Backup failed`

---

### Scenario F-10: Daily Shift Report (Automated)

**Trigger:** Cron, 6:00 AM
**Input:** "Generate and send the daily shift report for the past 24 hours..."

**Expected behavior:**
1. COSA selects the `shift-report-generation` skill from Layer 5
2. COSA calls `shift_report({ lookback_hours: 24 })`
3. COSA formats the response into the email template (§11.1)
4. COSA calls `emailGateway.sendEmail({ to: operator, subject: "[COSA] Shift Report: 2026-03-29", text: formattedReport })`
5. Session closes; alert logged for deduplication

---

### Scenario F-11: Novel Incident → Skill Creation

**Trigger:** Email from operator: "Something seems off, the last few hours had no temperature readings"
**Expected behavior:**
1. COSA runs `health_check` — station is healthy
2. COSA runs `db_query` to count recent readings — finds 0 rows in the last 3 hours
3. COSA checks Open-Meteo reachability via `health_check`'s HTTP check — API is unreachable
4. COSA replies to operator: "Readings gap confirmed: 0 readings in last 3 hours. Open-Meteo API is currently unreachable. The station is healthy. Readings will resume when the API recovers. No action needed."
5. Session closes (status: `complete`, tool calls: 3)
6. Post-session hook: 3 tool calls ≥ 2, no matching skill exists → skill creation triggered
7. Haiku generates `weather-readings-missing` skill document
8. Skill inserted into `skills.db`
9. Memory updated: `recentIncidents` gains new entry

---

### Scenario F-12: Memory Recall on Repeat Incident

**Trigger:** Cron health check — station unreachable

**Expected behavior:**
1. COSA runs `health_check` — returns `unreachable`
2. Context builder included MEMORY.md (Layer 4): contains "Incident 2026-03-27: SSH connectivity lost — resolved by waiting 10 min for router DHCP renewal"
3. COSA selects `ssh-connectivity-lost` skill (Layer 5)
4. COSA follows skill procedure: waits, retries health check
5. If recovered: updates memory `activeAnomalies: None`, sends no alert (brief outage within tolerance)
6. If still unreachable after retry: sends alert email with reference to prior incident

---

### Scenario F-13: Context Compression (Long Session)

**Trigger:** Email from operator: "Can you walk me through everything that happened with the backup last week?"

**Expected behavior:**
1. COSA calls `session_search({ query: "backup", limit: 10 })`
2. COSA calls `session_search({ query: "backup failed verify", limit: 5 })`
3. After several follow-up questions from operator, message array reaches 13 turns
4. `contextCompressor.needsCompression(messages)` returns true (13 > 12)
5. Compressor partitions: head (3 turns), middle (6 turns), tail (4 turns)
6. Haiku summarizes the middle 6 turns: "COSA searched session history for backup events on 2026-03-23 and 2026-03-25. Found 2 relevant sessions. Reported that both backups succeeded with checksums verified. Operator asked for checksum details."
7. Orchestrator replaces middle with summary turn and continues

---

### Scenario F-14: Settings Change with Approval

**Trigger:** Email from operator: "Can you change the reading interval to every 60 minutes to save API calls?"

**Expected behavior:**
1. COSA calls `settings_write({ key: "fetch.interval_minutes", value: "60", reason: "Operator requested reduce API call frequency" })`
2. `settings_write` has risk level `medium` → approval required
3. COSA sends approval request email: "I am about to change fetch.interval_minutes from 30 to 60. This will halve the weather reading frequency. Reply APPROVE-XXXXXXXX to confirm."
4. Operator replies `APPROVE-XXXXXXXX`
5. COSA executes the settings write
6. COSA replies: "Done. fetch.interval_minutes updated from 30 to 60. The station will now fetch readings every 60 minutes starting next cycle."
7. Memory updated: `operatorPreference: "Prefers lower API call frequency"` + `notes: "fetch.interval_minutes set to 60 on 2026-03-29"`

---

### Scenario F-15: Weekly Digest (Automated)

**Trigger:** Cron, Monday 2:00 AM
**Expected behavior:**
1. COSA calls `session_search({ query: "backup success failure", limit: 20 })` to gather backup history
2. COSA calls `session_search({ query: "health degraded unreachable alert", limit: 20 })` for health events
3. COSA queries `skills.db` for skills created or updated this week
4. COSA formats the digest (§11.2)
5. COSA sends digest email
6. Alert logged with category `digest` for deduplication

---

## 15. Appliance-Agnostic Core / Adapter Split

### 15.1 What lives in COSA core (unchanged between appliances)

- `orchestrator.js` — agent loop
- `memory-manager.js` — MEMORY.md read/write
- `skill-store.js` — skills.db CRUD + creation FSM
- `context-builder.js` — layer assembly + cache hints
- `context-compressor.js` — compression logic
- `session-store.js` — all session persistence
- `tool-registry.js` — registration + dispatch
- `security-gate.js` — dangerous command detection
- `approval-engine.js` — approval FSM + token handshake
- `email-gateway.js` — IMAP + SMTP
- `cron-scheduler.js` — cron runner
- `cli.js` — local REPL
- `ssh-backend.js` — SSH pool + command execution
- `session-search.js` tool — FTS5 session search (appliance-agnostic)
- `archive-search.js` tool — same as session-search; appliance-agnostic

### 15.2 What lives in the appliance adapter (swapped per appliance)

```
config/
├── appliance.yaml         ← SSH host, tool config, cron schedule, operator contact
├── APPLIANCE.md           ← Agent-readable identity (auto-updated by COSA)
└── OPERATIONS.md          ← Learned operational patterns (auto-updated)

src/tools/
├── shift-report.js        ← SQL query is appliance-specific
├── backup-run.js          ← Backup target (local JSONL vs S3) is appliance-specific
├── backup-verify.js       ← Checksum logic shared; S3 ETag check is appliance-specific
├── settings-write.js      ← Allowed keys and write method are appliance-specific
└── restart-appliance.js   ← Service name and health-check URL are from appliance.yaml

skills/seed/               ← 8 seed skills written for the appliance

data/MEMORY.md             ← Bootstrapped per appliance
```

### 15.3 Protocol of Interactions (Core Contract)

The adapter MUST expose the following to be compatible with COSA core:

1. **SSH accessibility** — COSA can run remote commands via SSH using a key pair registered during setup.
2. **Health endpoint** — `GET {api.base_url}{api.health_endpoint}` returns HTTP 200 when healthy.
3. **Ready endpoint** — `GET {api.base_url}{api.health_ready_endpoint}` returns HTTP 200 when accepting traffic.
4. **Process supervisor** — `systemctl show`, `systemctl restart {service}` work over SSH.
5. **SQLite database** — `sqlite3 -json {db_path}` is executable over SSH; the database has a read-friendly schema.
6. **Operator email** — A single email address configured in `appliance.yaml` that COSA sends reports and approval requests to.

Any appliance that satisfies these six primitives can be managed by COSA core without modification.

---

## 16. Phase 2 Acceptance Tests

### T-2.1 Backup Automation
1. Start COSA against WeatherStation. Wait for the 3:00 AM cron tick (or trigger manually).
2. Verify: a `.jsonl` file appears in the configured backup directory.
3. Verify: a `.sha256` sidecar appears alongside it.
4. Verify: `backup_verify` returns `{ verified: true }`.
5. Verify: MEMORY.md `lastBackup` section updated.
6. Verify: no alert email sent (success path).

### T-2.2 Shift Report Delivery
1. Trigger the 6:00 AM cron task manually.
2. Verify: an email arrives in the operator inbox with subject `[COSA] Shift Report: {today}`.
3. Verify: the email body contains temperature min/max/avg and total readings.
4. Verify: no second email is sent if the cron fires again within 6 hours (deduplication).

### T-2.3 Skill Creation from Novel Incident
1. Simulate a novel incident requiring 3+ tool calls in a single session.
2. After the session closes, verify: `skills.db` contains a new row with `use_count = 0`.
3. Verify: the skill document passes format validation (has Overview, Steps, Expected Outcomes sections).
4. Verify: MEMORY.md `recentIncidents` updated.

### T-2.4 Skill Reuse
1. Trigger a second session that matches an existing skill's "Applies when" description.
2. Verify: COSA includes the skill in Layer 5 (observable in session logs: the system prompt contains the skill's name).
3. After the session closes, verify: `skill_uses` table has a new row for this session.

### T-2.5 Memory Persistence
1. Trigger a health check cron that finds the station healthy.
2. Verify: MEMORY.md `## Appliance Health` section updated with timestamp.
3. Trigger a simulated degraded health check.
4. Verify: MEMORY.md `## Active Anomalies` section updated.
5. Start a new session (separate orchestrator call). Verify: MEMORY.md contents appear in the system prompt.

### T-2.6 Context Compression
1. Send 14 sequential CLI messages in the same test session (mock a long conversation).
2. Verify: after turn 13, the orchestrator splices a summary turn into the messages array.
3. Verify: the compressed messages array length ≤ `protectFirstN + 1 + protectLastN` = 8.
4. Verify: the raw turns are preserved in `session.db`.

### T-2.7 Settings Change Approval Flow
1. Send operator email: "Set fetch.interval_minutes to 60."
2. Verify: COSA sends an approval request email with an `APPROVE-XXXXXXXX` token.
3. Reply with the token.
4. Verify: COSA executes `settings_write` and replies confirming the change.
5. Verify: `station_info` table on WeatherStation has `key='fetch.interval_minutes', value='60'`.

### T-2.8 Session Search
1. Complete 3 sessions with known content.
2. Send operator email: "Did the backup fail recently?"
3. Verify: COSA calls `session_search` and returns excerpts from relevant prior sessions.

### T-2.9 Weekly Digest
1. Trigger the weekly digest cron manually.
2. Verify: operator receives email with subject `[COSA] Weekly Digest: week of {date}`.
3. Verify: digest includes health check count, backup count, and skills section.
4. Trigger the cron again within 6 days. Verify: no second digest sent.

### T-2.10 CLI Interface
1. Start COSA with `--cli` flag.
2. Type "What is the current station status?"
3. Verify: COSA calls `health_check` and prints a response to stdout.
4. Type "exit". Verify: process exits cleanly.

---

## 17. Model Usage by Task

| Task | Model | Rationale |
|---|---|---|
| All OPERATE sessions (default) | `claude-sonnet-4-6` | Sufficient for tool dispatch and report generation |
| Skill generation (post-incident) | `claude-sonnet-4-6` | Requires structured output quality |
| Context compression | `claude-haiku-4-5-20251001` | Low-stakes summarization; cost-sensitive |
| Weekly digest generation | `claude-sonnet-4-6` | Structured multi-source synthesis |

---

## 18. Open Questions

**1. `backup_run` approval scope**

For the nightly backup cron, requiring interactive approval every night defeats the purpose of autonomous operation. The approval policy for `backup_run` when triggered by cron should be `always` (pre-approved) rather than `once`.

*Proposed resolution:* Add an `auto_approve_cron` flag to `appliance.yaml` per tool. When a tool is invoked by a cron trigger with `auto_approve_cron: true`, the approval engine bypasses the interactive approval flow. This flag is only settable in config, not by the agent at runtime.

**2. FTS5 trigger maintenance cost**

Adding INSERT/UPDATE/DELETE triggers to the `turns` table adds overhead to every turn save. On low-power hardware (Raspberry Pi), this may be measurable.

*Proposed resolution:* Benchmark on Pi hardware before Phase 2 launch. Alternative: use `INSERT INTO turns_fts(turns_fts) VALUES('rebuild')` once at startup rather than per-row triggers. Trade-off: last-session turns won't be searchable until next startup.

**3. OPERATIONS.md write discipline**

The architecture requires COSA to auto-update `OPERATIONS.md` when it discovers new operational patterns. This is powerful but risky — an erroneous auto-update could poison future sessions.

*Proposed resolution:* Defer OPERATIONS.md auto-update to Phase 3. In Phase 2, OPERATIONS.md is operator-maintained only. COSA reads it but never writes it. This reduces risk and simplifies Phase 2 scope.

---

## 19. SAM Pattern Integration

Phase 2 extends the SAM pattern adoption established in Phase 1 (§20 of `cosa_phase1_spec.md`) to cover three additional stateful workflows introduced in this phase.

Libraries remain the same:

- **`@cognitive-fab/sam-pattern`** (`^1.6.1`) — SAM runtime
- **`@cognitive-fab/sam-fsm`** (`^1.0.0`) — FSM definitions

---

### 19.1 Session Lifecycle FSM (`SessionFSM`)

Every COSA session (email-triggered or CLI) has a well-defined lifecycle. This must be implemented as a `@cognitive-fab/sam-fsm` machine inside `orchestrator.js`.

#### States

| State | Meaning |
|---|---|
| `idle` | No active session; waiting for trigger (email, cron, CLI) |
| `running` | Session active; LLM generating or text-only response |
| `awaiting_tool` | LLM produced a tool call; security gate passed; executing tool |
| `awaiting_approval` | Tool call requires `once` approval; waiting for operator email reply |
| `compressing` | Turn count exceeded compression threshold; Haiku summarization in progress |
| `complete` | Session concluded normally; reply sent or CLI prompt returned |
| `error` | Unrecoverable error (LLM timeout, SSH failure after retries); operator notified |

#### Key Transitions

| From | Event | To |
|---|---|---|
| `idle` | `trigger(msg)` | `running` |
| `running` | `tool_proposed` | `awaiting_tool` (risk=read) or `awaiting_approval` (risk≥medium) |
| `awaiting_tool` | `tool_result(r)` | `running` |
| `awaiting_approval` | `approved` | `awaiting_tool` |
| `awaiting_approval` | `denied` / `expired` | `running` (LLM informed; no tool executed) |
| `running` | `threshold_exceeded` | `compressing` |
| `compressing` | `compression_done` | `running` |
| `running` | `finish` | `complete` |
| `running` / `awaiting_tool` | `fatal_error(e)` | `error` |
| `complete` / `error` | `reset` | `idle` |

#### SAM-FSM Integration Mechanism

Use the **State Machine Reactor** integration mechanism. The reactor fires after each model mutation (tool result written, compression complete, approval decision received) and consults the FSM to determine the next state, then invokes the appropriate NAP.

---

### 19.2 Skill Creation FSM (`SkillCreationFSM`)

When the orchestrator's post-session hook determines that a novel incident occurred (no matching skill found in `skills.db`), the skill creation workflow is initiated. This workflow is a six-state FSM inside `skill-store.js`.

#### States

| State | Meaning |
|---|---|
| `idle` | No skill creation in progress |
| `evaluating` | Post-session hook checking whether a novel incident occurred |
| `searching` | FTS5 search of `skills.db` for a matching existing skill |
| `generating` | Calling `claude-sonnet-4-6` to generate a new skill in agentskills.io format |
| `validating` | Checking generated skill YAML/Markdown structure; dry-run test of trigger pattern |
| `persisted` | Skill inserted into `skills.db`; operator notified by email |

#### Transitions

| From | Event | Guard | To |
|---|---|---|---|
| `idle` | `post_session_hook(incident)` | — | `evaluating` |
| `evaluating` | `novel_detected` | incident confidence > threshold | `searching` |
| `evaluating` | `not_novel` | — | `idle` |
| `searching` | `no_match` | FTS5 score below similarity floor | `generating` |
| `searching` | `match_found` | — | `idle` (existing skill flagged for improvement only) |
| `generating` | `generated(skill)` | — | `validating` |
| `validating` | `valid` | schema check passes | `persisted` |
| `validating` | `invalid` | schema check fails | `generating` (retry, max 2) |
| `validating` | `retry_exceeded` | retries ≥ 2 | `idle` (log failure; no skill saved) |
| `persisted` | `reset` | — | `idle` |

#### SAM-FSM Integration Mechanism

Use the **Action Binding** integration mechanism. Each FSM state transition is driven by calling the corresponding sam-pattern action (e.g. `actions.detectNovelty`, `actions.searchSkills`, `actions.generateSkill`). The sam-fsm machine acts as the acceptor that validates the transition before the model is mutated.

---

### 19.3 Context Compression as a SAM Step

Context compression (§9) fits naturally as a single SAM cycle within the SessionFSM:

| SAM Role | Compression Equivalent |
|---|---|
| **Action** | `actions.proposeCompression({ turns, tokenEstimate })` — triggered when token estimate exceeds threshold |
| **Acceptor** | Guard: `tokenEstimate > compressionThreshold`. If not exceeded, action is rejected and the model is not mutated (no compression runs). |
| **Model mutation** | Call Haiku to summarize middle turns; splice summary back into the message array; set `parent_session_id` on the session record in `session.db` |
| **Reactor** | Resume the SessionFSM: fire `compression_done` event, transitioning back to `running` |

This replaces the proposed ad-hoc `if (tokens > threshold)` branch in `context-compressor.js` with a proper sam-pattern action/acceptor pair, making compression threshold enforcement testable via the sam-pattern model checker.

---

### 19.4 Memory Update as a SAM Acceptor

MEMORY.md updates (§7) are implemented as a sam-pattern **acceptor** rather than a direct write call. This ensures the ≤2200 character invariant is enforced at the model level before any write reaches the filesystem.

| SAM Role | Memory Update Equivalent |
|---|---|
| **Action** | `actions.updateMemory({ patch })` — called after any session that produced new operational facts |
| **Acceptor** | Merge `patch` into current memory snapshot; check total length. If `length(merged) > 2200`, prune oldest entries until the invariant holds. Only then accept the mutation. |
| **Model mutation** | Write updated `MEMORY.md` to disk |
| **Reactor** | None (memory update is a leaf operation with no downstream NAP) |

This guarantees the 2200-char limit is **never violated** — the acceptor either prunes and accepts, or rejects if even a minimal patch exceeds the limit (edge case: single entry > 2200 chars; this should throw a validation error at the action site, not the acceptor).

---

### 19.5 Module Dependency Updates

Add the following to `package.json` (Phase 2 additions to Phase 1 dependencies):

```json
{
  "dependencies": {
    "@cognitive-fab/sam-pattern": "^1.6.1",
    "@cognitive-fab/sam-fsm": "^1.0.0"
  }
}
```

Both libraries are already listed in Phase 1 (§20.1). Phase 2 adds no new SAM dependencies — it extends the existing instances.

---

### 19.6 Test Coverage

| FSM / SAM component | Required test cases |
|---|---|
| `SessionFSM` | All 7 states reachable; `error` state from both `running` and `awaiting_tool`; `compressing` → `running` roundtrip |
| `SkillCreationFSM` | Happy path `idle → persisted`; `match_found` short-circuit; `retry_exceeded` after 2 invalid generations |
| Context compression | Acceptor rejects when `tokenEstimate ≤ threshold`; model checker asserts ≤2200 char MEMORY.md invariant after any memory update |
| Memory acceptor | Pruning fires when merge would exceed limit; single-entry overflow throws at action site |

*End of COSA Phase 2 Specification v0.1*
