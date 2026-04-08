# Generic Appliance REST Connector — Tool Specifications

**Project:** COSA  
**Branch:** baanbaan  
**Date:** 2026-04-08  
**Status:** Draft — supersedes the earlier BaanBaan-specific tool design

---

## Overview

This document specifies two generic tools and a supporting subsystem that together give COSA first-class integration with any REST-capable appliance. BaanBaan is the first target, but no BaanBaan-specific code lives in COSA — all appliance-specific details are configuration.

### Design Principles

- **No appliance-specific tools.** COSA does not compile knowledge of BaanBaan's order model, endpoints, or auth scheme. Those details live in `appliance.yaml` and the credential store.
- **Monitoring via watchers, not hardcoded checks.** The operator describes conditions in plain language by email. Claude generates small predicate functions from the live status snapshot and stores them. Every subsequent poll runs them automatically.
- **Write operations via allowlist.** The only write actions COSA can perform are the ones explicitly listed in `appliance.yaml`. Claude resolves which entry to use; it cannot call arbitrary endpoints.

### Architecture

```
                    ┌─────────────────────────────────────────┐
                    │  appliance.yaml                         │
                    │  ├─ appliance_api.status_endpoint       │
                    │  ├─ appliance_api.auth  (jwt / api_key) │
                    │  └─ appliance_api.api_endpoints[]       │
                    └──────────────┬──────────────────────────┘
                                   │ config
               ┌───────────────────┼────────────────────┐
               ▼                                        ▼
   appliance_status_poll                      appliance_api_call
   ─────────────────────                      ─────────────────
   GET {status_endpoint}                      Allowlist lookup
        │                                          │
        ▼                                          ▼ (requires approval)
   Watcher Registry                          PATCH / POST to appliance
   (run all watchers)
        │
        ▼
   Triggered alerts → orchestrator → email operator
```

### New Files

| File | Type | Purpose |
|------|------|---------|
| `src/tools/appliance-status-poll.js` | Registered tool | Poll status endpoint; run watchers |
| `src/tools/appliance-api-call.js` | Registered tool | Authenticated write to allowlisted endpoint |
| `src/appliance-auth.js` | Internal module | Generic JWT / API-key auth with refresh-on-401 |
| `src/watcher-registry.js` | Internal subsystem | Store, run, and manage watcher functions |

### Tool Inventory

| Tool | File | Risk | Approval |
|------|------|------|----------|
| `appliance_status_poll` | `src/tools/appliance-status-poll.js` | `read` | auto |
| `appliance_api_call` | `src/tools/appliance-api-call.js` | `medium` or `high` (per allowlist entry) | auto (email), once (cron/CLI) |

---

## Prerequisites: Setup Wizard

Before either tool can run, the COSA setup wizard (`npm run setup`) must have completed against the target appliance. The wizard:

1. Calls `GET /setup/info` to discover SSH fingerprint, LAN IP, database path, service name, and timezone
2. Calls `POST /setup/register-ssh-key` (with a 6-digit PIN) to install COSA's SSH public key on the Pi
3. Auto-populates `config/appliance.yaml` — no manual placeholder values
4. Obtains auth credentials and stores them in the credential store

Full setup API contract: `docs/baanbaan-setup-api-spec.md`.

---

## `appliance.yaml` — Generic Appliance API Config

The two new sections that enable these tools:

```yaml
appliance_api:
  base_url: "http://192.168.1.X:3000"     # auto-populated by setup wizard
  health_endpoint: "/health"
  health_ready_endpoint: "/health"
  request_timeout_ms: 10000

  # Generic status snapshot endpoint — the single source of truth for watchers.
  # The appliance must return a JSON object; COSA treats the schema as opaque.
  status_endpoint: "/api/status"
  status_poll_interval_s: 60              # cron interval; also callable on-demand

  # Authentication config — COSA uses this to obtain and refresh tokens automatically.
  auth:
    type: "jwt"                           # "jwt" | "api_key" | "none"

    # JWT-specific (ignored for other auth types)
    login_endpoint: "/api/auth/login"
    login_body_template: '{"email":"${credential:appliance_email}","password":"${credential:appliance_password}"}'
    refresh_endpoint: "/api/auth/refresh"
    refresh_body_template: '{"refreshToken":"${credential:appliance_refresh_token}"}'
    access_token_ttl_minutes: 15
    access_token_credential_key: "appliance_access_token"
    refresh_token_credential_key: "appliance_refresh_token"

    # API-key-specific (ignored for jwt auth type)
    # api_key_credential_key: "appliance_api_key"
    # api_key_header: "X-API-Key"

  # Allowlist of endpoints appliance_api_call may invoke.
  # Claude picks the right entry by name; it cannot call anything not listed here.
  api_endpoints:
    - name: "update_order_status"
      path: "/api/merchants/:merchantId/orders/:orderId/status"
      method: PATCH
      risk: medium
      description: "Transition an order to a new status"
      path_params:
        merchantId: "${credential:appliance_merchant_id}"  # static — resolved from credential store
        orderId: caller                                     # dynamic — provided by Claude at call time
      body_schema:
        type: object
        properties:
          status:
            type: string
            enum: [confirmed, preparing, ready, completed, cancelled]
          note:
            type: string
        required: [status]

    - name: "pause_store"
      path: "/api/merchants/:merchantId/store/pause"
      method: PATCH
      risk: high
      description: "Pause or resume online ordering"
      path_params:
        merchantId: "${credential:appliance_merchant_id}"
      body_schema:
        type: object
        properties:
          paused:
            type: boolean
          reason:
            type: string
        required: [paused, reason]

tools:
  appliance_status_poll:
    enabled: true
    watcher_timeout_ms: 200       # max execution time per watcher (sandboxed)
    alert_cooldown_minutes: 30    # min time between repeated alerts for same watcher
  appliance_api_call:
    enabled: true
```

**Credential store keys** (populated by setup wizard):
- `appliance_access_token` — JWT access token
- `appliance_refresh_token` — JWT refresh token
- `appliance_merchant_id` — static path param resolved at call time
- `appliance_email` / `appliance_password` — used only if full re-login is needed

---

## Internal Module: `src/appliance-auth.js`

Shared auth helper used by both tools. Not a registered tool.

```javascript
/**
 * Execute an authenticated appliance API call. Reads auth config from
 * appliance.yaml and credentials from the credential store. Refreshes
 * the access token automatically on a 401 response. Falls back to full
 * re-login if the refresh token has also expired.
 *
 * @param {Function} apiFn  - async (headers: object) => { status, body }
 * @returns {Promise<{ status: number, body: object }>}
 * @throws {Error} with code 'APPLIANCE_AUTH_FAILED' if all auth attempts fail
 */
async function withApplianceAuth(apiFn) { ... }
```

**Auth flow:**

```
1. Read access token from credential store
2. Call apiFn({ Authorization: `Bearer ${token}` })
3. If 200-299 → return result
4. If 401:
   a. POST refresh_endpoint with refresh token
   b. If 200 → store new access token, retry apiFn once
   c. If 401 on refresh → POST login_endpoint to get fresh token pair
   d. If login fails → throw APPLIANCE_AUTH_FAILED, email operator
5. Any other error → throw APPLIANCE_NETWORK_ERROR
```

---

## Internal Subsystem: `src/watcher-registry.js`

The watcher registry lets operators define monitoring conditions in plain language. Claude translates them to code; the registry stores and executes them.

### What a Watcher Is

A watcher is a named JavaScript predicate stored in the session database. It receives the latest status snapshot and returns whether a condition is met:

```javascript
/**
 * Watcher function contract.
 * @param {object} status - The raw JSON from the appliance's status_endpoint
 * @returns {{ triggered: boolean, message?: string }}
 */
function watcherFn(status) {
  // Example: printer fault detection
  const printer = status?.hardware?.printer;
  if (!printer || printer.status === 'fault' || printer.status === 'absent') {
    return { triggered: true, message: `Printer is ${printer?.status ?? 'absent'}` };
  }
  return { triggered: false };
}
```

**Sandbox constraints** (enforced via `node:vm`):
- No `require()` or `import`
- No network, filesystem, or process access
- Execution time capped at `watcher_timeout_ms` (default 200ms)
- Input is a frozen deep-clone of the status object (no mutation)
- Return value must be `{ triggered: boolean, message?: string }` — anything else is treated as `{ triggered: false }`

### Watcher Storage Schema

Stored in `data/session.db`, new table `watchers`:

```sql
CREATE TABLE watchers (
  id              TEXT PRIMARY KEY,       -- e.g. "printer_fault"
  name            TEXT NOT NULL,          -- human-readable label
  description     TEXT NOT NULL,          -- original operator request (natural language)
  code            TEXT NOT NULL,          -- JS function body (generated by Claude)
  created_at      TEXT NOT NULL,
  last_triggered_at TEXT,
  trigger_count   INTEGER DEFAULT 0,
  last_alerted_at TEXT,                   -- for cooldown tracking
  enabled         INTEGER DEFAULT 1
);
```

### Watcher Lifecycle: Email-Driven Creation

```
Operator email:
  "Let me know when the printer status is faulty or absent."

Orchestrator flow:
  1. Claude calls appliance_status_poll (no watchers run yet — just fetch snapshot)
  2. Claude inspects the snapshot structure, finds hardware.printer.status
  3. Claude generates a watcher function targeting that path
  4. Claude calls watcher_registry.register({ id, name, description, code })
     (internal API — not a COSA tool; Claude calls it directly via orchestrator hook)
  5. Registry stores the watcher in session.db
  6. COSA replies: "Got it — I'll alert you whenever the printer goes offline."

On every subsequent appliance_status_poll:
  7. Registry runs all enabled watchers against the new snapshot
  8. If printer_fault triggers AND cooldown has passed:
     → result includes { alerts: [{ watcher: "printer_fault", message: "Printer is fault" }] }
  9. Orchestrator sends alert email to operator
```

### Registry API (internal, called by orchestrator)

```javascript
class WatcherRegistry {
  /** Store a new watcher or replace an existing one by id */
  async register({ id, name, description, code }) { ... }

  /** Run all enabled watchers against a status snapshot */
  async runAll(statusSnapshot) {
    // Returns: { alerts: [{ watcherId, name, message }], errors: [...] }
  }

  /** List all watchers (for operator queries: "what am I watching for?") */
  async list() { ... }

  /** Enable, disable, or delete a watcher by id */
  async setEnabled(id, enabled) { ... }
  async remove(id) { ... }
}
```

### Operator Management Commands (email)

Because Claude has access to the registry via the orchestrator, operators can manage watchers with natural language:

| Operator says | Claude action |
|---------------|---------------|
| "Let me know when pending orders exceed 10" | Registers new watcher |
| "What are you watching for?" | Calls `registry.list()`, emails summary |
| "Stop watching the printer" | Calls `registry.setEnabled('printer_fault', false)` |
| "Show me the printer watcher code" | Reads watcher from DB, emails the JS function |
| "Update the printer watcher to also trigger on 'degraded'" | Regenerates and re-registers |

---

## Tool 1 — `appliance_status_poll`

**File:** `src/tools/appliance-status-poll.js`  
**Risk level:** `read`  
**Purpose:** Fetch a live status snapshot from the appliance, run all registered watchers, and return both the raw snapshot and any triggered alerts. Called on a cron schedule and on-demand.

### JSON Schema

```javascript
const SCHEMA = {
  description:
    'Fetch a live status snapshot from the appliance status endpoint and run ' +
    'all registered condition watchers against it. Returns the raw status and ' +
    'any alerts that fired. Use to check appliance health or trigger monitoring.',
  inputSchema: {
    type: 'object',
    properties: {
      skip_watchers: {
        type: 'boolean',
        description:
          'If true, fetch the snapshot but do not run watchers. ' +
          'Useful when Claude needs to inspect the status schema (e.g. to create a new watcher).',
      },
    },
    required: [],
    additionalProperties: false,
  },
};
```

### Handler Logic

```
1. Read base_url + status_endpoint from appliance.yaml
2. GET {base_url}{status_endpoint}
   Auth header from withApplianceAuth()
   Timeout: request_timeout_ms
3. If skip_watchers is true → return { success, snapshot, alerts: [], polled_at }
4. Call watcherRegistry.runAll(snapshot)
5. For each triggered alert where cooldown has passed:
   a. Update watcher.last_alerted_at in DB
   b. Include in result alerts[]
6. Return result
```

### Result Shape

```javascript
// snapshot with no alerts
{
  success: true,
  snapshot: {
    store: { paused: false, online_ordering: true },
    orders: { pending: 3, preparing: 1, ready: 0 },
    hardware: {
      printer: { status: "ok", ip: "192.168.1.50" },
      terminal: { status: "ok" }
    },
    system: { uptime_s: 84600, db: "ok", version: "1.4.2" }
  },
  alerts: [],
  watchers_run: 2,
  polled_at: "2026-04-08T12:00:00.000Z"
}

// snapshot with a triggered alert
{
  success: true,
  snapshot: { ... },
  alerts: [
    {
      watcher_id: "printer_fault",
      watcher_name: "Printer fault or absent",
      message: "Printer is fault",
      triggered_at: "2026-04-08T12:05:00.000Z"
    }
  ],
  watchers_run: 2,
  polled_at: "2026-04-08T12:05:00.000Z"
}

// appliance unreachable
{
  success: false,
  snapshot: null,
  alerts: [],
  error: "Request timed out after 10000ms",
  code: "APPLIANCE_NETWORK_ERROR",
  polled_at: "2026-04-08T12:00:00.000Z"
}
```

### Cron Integration

```yaml
# appliance.yaml
cron:
  appliance_status_poll: "* * * * *"    # every minute (adjust per appliance cadence)
```

When triggered by cron: if `alerts[]` is non-empty, orchestrator sends an alert email to the operator without requiring a human prompt.

---

## Tool 2 — `appliance_api_call`

**File:** `src/tools/appliance-api-call.js`  
**Risk level:** resolved at runtime from the allowlist entry (`medium` or `high`)  
**Purpose:** Make an authenticated write (or read) call to a pre-approved endpoint. Claude selects the endpoint by name; the tool resolves path parameters, enforces the body schema, and handles auth.

### JSON Schema

```javascript
const SCHEMA = {
  description:
    'Make an authenticated call to a pre-approved appliance API endpoint. ' +
    'The endpoint must be listed in appliance_api.api_endpoints in appliance.yaml. ' +
    'Provide the endpoint name, any dynamic path parameters, and the request body.',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint_name: {
        type: 'string',
        description:
          'The name of the endpoint as listed in appliance.yaml api_endpoints ' +
          '(e.g. "update_order_status", "pause_store").',
      },
      path_params: {
        type: 'object',
        description:
          'Dynamic path parameter values (only params marked "caller" in the config). ' +
          'Static params (e.g. merchantId) are resolved automatically from the credential store.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'object',
        description: 'Request body. Must conform to the endpoint body_schema in appliance.yaml.',
        additionalProperties: true,
      },
      reason: {
        type: 'string',
        maxLength: 500,
        description: 'Required for high-risk endpoints. Included in the operator approval email.',
      },
    },
    required: ['endpoint_name', 'body'],
    additionalProperties: false,
  },
};
```

### Handler Logic

```
1. Look up endpoint_name in appliance.yaml api_endpoints[]
   → If not found: return APPLIANCE_ENDPOINT_NOT_ALLOWED

2. Resolve risk level from the allowlist entry
   → Tool registry uses this to determine approval gate at dispatch time

3. Resolve path:
   a. For each param in path template:
      - If config value is "${credential:KEY}" → read from credential store
      - If config value is "caller" → read from input.path_params[param]
      - If input provides a param not marked "caller" → return APPLIANCE_PARAM_INJECTION

4. Validate body against endpoint.body_schema (AJV)
   → If invalid: return APPLIANCE_BODY_INVALID with validation errors

5. Build final URL: base_url + resolved path

6. Make HTTP request via withApplianceAuth():
   method: endpoint.method
   url: resolved URL
   body: JSON.stringify(input.body)
   timeout: request_timeout_ms

7. Return structured result
```

**Injection prevention:** Step 3c blocks callers from overriding static path params (e.g., `merchantId`). Claude can only fill in params explicitly designated as `caller` in the config. This prevents Claude from being instructed to call the endpoint for a different merchant.

### Result Shape

```javascript
// success
{
  success: true,
  endpoint_name: "update_order_status",
  method: "PATCH",
  status_code: 200,
  body: { orderId: "ord_abc123", status: "confirmed", updatedAt: "..." },
  actioned_at: "2026-04-08T12:00:00.000Z"
}

// endpoint not in allowlist
{
  success: false,
  error: "Endpoint 'cancel_all_orders' is not in the appliance.yaml allowlist",
  code: "APPLIANCE_ENDPOINT_NOT_ALLOWED",
  actioned_at: "2026-04-08T12:00:00.000Z"
}

// body failed schema validation
{
  success: false,
  error: "Request body is invalid",
  code: "APPLIANCE_BODY_INVALID",
  validation_errors: ["/status must be one of: confirmed, preparing, ready, completed, cancelled"],
  actioned_at: "2026-04-08T12:00:00.000Z"
}

// appliance returned an error
{
  success: false,
  endpoint_name: "update_order_status",
  status_code: 422,
  error: "Appliance returned 422",
  body: { error: "Invalid transition: completed → confirmed" },
  actioned_at: "2026-04-08T12:00:00.000Z"
}
```

### Risk Level at Dispatch

Because the risk level is resolved at runtime from the allowlist entry, the tool registry receives a special `riskLevel: 'dynamic'` marker. The orchestrator resolves the actual level from the endpoint config before invoking the approval gate:

```javascript
// In orchestrator.processToolUse():
if (tool.riskLevel === 'dynamic') {
  const endpointName = input.endpoint_name;
  const entry = getConfig().appliance.appliance_api.api_endpoints
    .find(e => e.name === endpointName);
  resolvedRisk = entry?.risk ?? 'high';  // default to high if unknown
}
```

---

## Watcher Creation Flow (End-to-End)

```
Operator email:
  "Alert me when there are more than 5 pending orders."

Step 1 — Claude calls appliance_status_poll({ skip_watchers: true })
  Returns snapshot:
  {
    orders: { pending: 2, preparing: 1, ready: 0 },
    ...
  }

Step 2 — Claude generates watcher code:
  function watch_high_pending_orders(status) {
    const pending = status?.orders?.pending ?? 0;
    if (pending > 5)
      return { triggered: true, message: `${pending} orders pending — kitchen may be overwhelmed` };
    return { triggered: false };
  }

Step 3 — Claude calls watcherRegistry.register({
  id: 'high_pending_orders',
  name: 'High pending order count',
  description: 'Alert when pending orders exceed 5',
  code: '<function body above>'
})

Step 4 — COSA replies to operator:
  "Done — I'll alert you when pending orders go above 5.
   I'm currently watching for 3 conditions:
   • Printer fault or absent
   • High pending order count  ← new
   • Payment reconciliation gap"

Step 5 — On every subsequent cron poll:
  watcherRegistry.runAll(snapshot) checks the condition.
  If pending > 5 and cooldown has passed → alert email is sent.
```

---

## Registration in `src/main.js`

```javascript
// Generic appliance connector tools
const applianceStatusPoll = require('./tools/appliance-status-poll');
const applianceApiCall    = require('./tools/appliance-api-call');
```

```javascript
for (const t of [
  // ... existing tools ...
  applianceStatusPoll,
  applianceApiCall,
]) {
  toolRegistry.register(t.name, t.schema, t.handler, t.riskLevel);
}
```

The watcher registry is instantiated once at boot and passed to the tools via the config/context object — it is not a registered tool itself.

---

## BaanBaan `appliance.yaml` (complete template)

Values marked `# wizard` are auto-populated by `npm run setup`.

```yaml
appliance:
  name: "BaanBaan POS"              # wizard
  timezone: "America/Chicago"       # wizard

ssh:
  host: "192.168.1.X"               # wizard
  port: 22
  user: "baanbaan"                  # wizard
  key_path: "/home/jjdub/.ssh/id_ed25519_cosa"
  host_key_fingerprint: "SHA256:..."  # wizard
  connect_timeout_ms: 5000
  command_timeout_ms: 30000

appliance_api:
  base_url: "http://192.168.1.X:3000"   # wizard
  health_endpoint: "/health"
  health_ready_endpoint: "/health"       # BaanBaan has no /health/ready
  status_endpoint: "/api/status"         # BaanBaan must implement this
  request_timeout_ms: 10000
  status_poll_interval_s: 60

  auth:
    type: "jwt"
    login_endpoint: "/api/auth/login"
    login_body_template: '{"email":"${credential:appliance_email}","password":"${credential:appliance_password}"}'
    refresh_endpoint: "/api/auth/refresh"
    refresh_body_template: '{"refreshToken":"${credential:appliance_refresh_token}"}'
    access_token_ttl_minutes: 15
    access_token_credential_key: "appliance_access_token"
    refresh_token_credential_key: "appliance_refresh_token"

  api_endpoints:
    - name: "update_order_status"
      path: "/api/merchants/:merchantId/orders/:orderId/status"
      method: PATCH
      risk: medium
      description: "Transition an order to a new status"
      path_params:
        merchantId: "${credential:appliance_merchant_id}"
        orderId: caller
      body_schema:
        type: object
        properties:
          status:
            type: string
            enum: [confirmed, preparing, ready, completed, cancelled]
          note:
            type: string
        required: [status]

    - name: "pause_store"
      path: "/api/merchants/:merchantId/store/pause"
      method: PATCH
      risk: high
      description: "Pause or resume online ordering"
      path_params:
        merchantId: "${credential:appliance_merchant_id}"
      body_schema:
        type: object
        properties:
          paused:
            type: boolean
          reason:
            type: string
        required: [paused, reason]

database:
  path: "/home/baanbaan/app/data/baanbaan.db"   # wizard
  read_only: true

process_supervisor:
  type: "systemd"
  service_name: "baanbaan"    # wizard

cron:
  health_check: "0 * * * *"
  appliance_status_poll: "* * * * *"

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
  restart_appliance:
    enabled: true
    graceful_timeout_seconds: 60
  pause_appliance:
    enabled: true
  appliance_status_poll:
    enabled: true
    watcher_timeout_ms: 200
    alert_cooldown_minutes: 30
  appliance_api_call:
    enabled: true
```

---

## What BaanBaan Must Add

The only BaanBaan-side change required beyond the setup API (see `docs/baanbaan-setup-api-spec.md`) is a single status endpoint:

```
GET /api/status  (authenticated)
```

Suggested response shape — the exact schema is opaque to COSA; Claude infers it on first poll:

```json
{
  "store": {
    "paused": false,
    "online_ordering": true
  },
  "orders": {
    "pending": 3,
    "preparing": 1,
    "ready": 0,
    "completed_today": 42
  },
  "hardware": {
    "printer": { "status": "ok", "ip": "192.168.1.50", "model": "Star TSP100" },
    "terminal": { "status": "ok", "model": "Finix V400c" }
  },
  "payments": {
    "last_reconciled_at": "2026-04-08T11:00:00Z",
    "unmatched_count": 0
  },
  "system": {
    "uptime_s": 84600,
    "db": "ok",
    "version": "1.4.2",
    "last_backup_at": "2026-04-08T03:00:00Z"
  }
}
```

The richer this object, the more useful the watcher system becomes. No other new endpoints are needed for monitoring.

---

## Implementation Checklist

**BaanBaan (prerequisite):**
- [ ] Implement `GET /setup/info`, `POST /setup/register-ssh-key`, `GET /setup/status` (see `docs/baanbaan-setup-api-spec.md`)
- [ ] Implement `GET /api/status` returning the snapshot shape above

**COSA — core:**
- [ ] `src/appliance-auth.js` — generic JWT / API-key auth with full re-login fallback
- [ ] `src/watcher-registry.js` — store, sandbox, run, manage watchers (uses `node:vm`)
- [ ] `src/tools/appliance-status-poll.js`
- [ ] `src/tools/appliance-api-call.js`
- [ ] Dynamic risk-level resolution in `src/orchestrator.js`
- [ ] Register both tools in `src/main.js`
- [ ] Add watcher management to orchestrator session hook (so Claude can call `register`, `list`, `remove`)
- [ ] Update `config/appliance.yaml` schema support (auth block, api_endpoints, status_endpoint)

**COSA — setup wizard:**
- [ ] `npm run setup` integrated with BaanBaan setup API (see Gap G-6 in `docs/baan_baan_integration.md`)

**Tests:**
- [ ] `tests/appliance-auth.test.js` — refresh-on-401, re-login fallback
- [ ] `tests/watcher-registry.test.js` — sandbox enforcement, cooldown, trigger count
- [ ] `tests/appliance-status-poll.test.js` — snapshot fetch, watcher execution, alert output
- [ ] `tests/appliance-api-call.test.js` — allowlist enforcement, param injection prevention, body validation

**Close out:**
- [ ] Update Gaps G-1, G-2, G-4, G-5 in `docs/baan_baan_integration.md` — all resolved by this design
- [ ] Update Gap G-6 once setup wizard is wired
