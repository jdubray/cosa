Two distinct root causes, both in `backup-run.js`. Here's the full diagnosis and plan:

---

## Root Cause Analysis

### Bug 1 — `node: command not found` (exit 127)
**Location:** `src/tools/backup-run.js:96`

```javascript
const nodeTransform =
  `node -e "let d='';process.stdin.on('data',c=>d+=c)` +
  `.on('end',()=>JSON.parse(d).forEach(r=>console.log(JSON.stringify(r))))"`;
```

The script hardcodes `node` as the JSON→JSONL transformer. The comment on line 74 even says *"Node.js is used because it is guaranteed to be installed"* — an assumption that was true for WeatherStation but false for BaanBaan, which runs on **Bun** with no `node` binary in PATH.

### Bug 2 — `no such table: readings`
**Location:** `src/tools/backup-run.js:102`

```javascript
`sqlite3 -json ${qDb} 'SELECT * FROM readings' | ${nodeTransform} > ${qBackup}`
```

`readings` is the WeatherStation's data table. BaanBaan's database has **no `readings` table** — its schema has `orders`, `merchants`, `menu_items`, `employees`, etc. (30 tables total). The table name is hardcoded, not configurable.

### Why both fired together
`set -euo pipefail` on line 100 means the whole pipeline fails as soon as either command fails. Both `sqlite3` (table not found) and `node` (binary not found) error simultaneously on line 3 of the script — both errors appear in `stderr`, both land in the COSA alert.

---

## Fix Plan

### Part 1 — Make `backup-run.js` generic (fixes both bugs permanently)

**File:** `src/tools/backup-run.js`

**Change A — configurable JS runtime:**

Replace the hardcoded `node` string with a shell auto-detection expression, using a new optional config key `tools.backup_run.js_runtime`:

```javascript
// If config specifies a runtime, use it directly.
// Otherwise auto-detect: prefer bun, fall back to node.
const jsRuntime = appliance.tools?.backup_run?.js_runtime ?? null;
const runtimeExpr = jsRuntime
  ? `'${shEscape(jsRuntime)}'`
  : `$(which bun 2>/dev/null || which node 2>/dev/null || echo '')`;
```

The generated script gets a guard at the top:
```bash
JSRT=<runtimeExpr>
[ -z "$JSRT" ] && { echo "No JS runtime (bun/node) found in PATH" >&2; exit 1; }
```

Then line 102 becomes `sqlite3 -json ... | "$JSRT" -e "..." > ...`

**Change B — configurable tables:**

Replace the hardcoded `readings` with `tools.backup_run.tables[]` from config. Default to `['readings']` for backward compatibility with WeatherStation.

```javascript
const tables = appliance.tools?.backup_run?.tables ?? ['readings'];
```

`buildScript()` loops over `tables`, produces one JSONL file per table, and outputs one `rowCount\nchecksum` pair per table. The handler accumulates them into `backup_files: [{ table, path, row_count, checksum }]` in the result.

**Change C — filename**

Rename backup files from `readings_*.jsonl` to `{table}_*.jsonl` so each table gets its own timestamped file.

**New tests:** `tests/backup-run.test.js`
- runtime auto-detection when `js_runtime` not configured
- configurable `js_runtime: "bun"` used correctly
- multi-table loop produces one file per table
- script failure returns `success: false` with structured error

---

### Part 2 — `appliance.yaml` for BaanBaan (immediate unblock)

This is the config-only change that fixes tonight's backup without waiting for Part 3.

```yaml
tools:
  backup_run:
    enabled: true
    backup_dir: "/tmp/cosa-backups"
    timeout_s: 120
    js_runtime: "bun"          # fixes Bug 1
    tables:                    # fixes Bug 2
      - orders
      - merchants
      - employees
      - menu_items
```

This works once Part 1 is implemented.

---

### Part 3 — Strategic: use BaanBaan's own backup API (right long-term answer)

BaanBaan already has a fully-featured HTTP backup endpoint: `GET /api/merchants/:id/backup?type=full`. It knows its own schema, handles its own serialization, and supports S3 upload natively. Using raw SQLite over SSH for BaanBaan is the wrong tool.

**Add to `appliance.yaml` api_endpoints allowlist:**

```yaml
api_endpoints:
  - name: "trigger_backup"
    path: "/api/merchants/:merchantId/backup"
    method: GET
    risk: read
    description: "Export a full backup of all merchant data via BaanBaan's backup API"
    path_params:
      merchantId: "${credential:appliance_merchant_id}"
    query_params:
      type: "full"
```

**Then disable the SSH-based backup for BaanBaan:**

```yaml
tools:
  backup_run:
    enabled: false   # BaanBaan uses GET /api/merchants/:id/backup?type=full instead
```

The operator triggers backups by emailing COSA "run a backup", Claude calls `appliance_api_call` with `endpoint_name: "trigger_backup"`.

---

## Summary

| # | Change | File | Fixes | Priority |
|---|--------|------|-------|----------|
| 1A | Configurable `js_runtime` with auto-detect fallback | `src/tools/backup-run.js` | Bug 1 | P0 |
| 1B | Configurable `tables[]` array | `src/tools/backup-run.js` | Bug 2 | P0 |
| 1C | Per-table output files + updated result shape | `src/tools/backup-run.js` | cleanliness | P0 |
| 2 | Set `js_runtime: bun` + correct `tables[]` | `config/appliance.yaml` | both bugs tonight | P0 (config only) |
| 3 | Add `trigger_backup` to api_endpoints; disable `backup_run` | `config/appliance.yaml` | architecture | P1 |
| 4 | New tests for generic backup-run | `tests/backup-run.test.js` | coverage | P1 |

**Unblocks tonight:** Part 1 (code) + Part 2 (config) — backup will use `bun` and export the right BaanBaan tables.  
**Right long-term:** Part 3 removes the SSH+SQLite dependency entirely for BaanBaan.