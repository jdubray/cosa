# settings_write — `station_info` table mismatch

**Status:** Tool disabled (2026-06-08) — `config/appliance.yaml` `tools.settings_write.enabled: false`
**Owner decision needed:** yes (write path into BaanBaan's `merchant.db`)

## Problem

COSA's `settings_write` tool (`src/tools/settings-write.js`) reads and writes a
table named **`station_info`** in the appliance database
(`appliance.database.path` → `/home/baanbaan/baan-baan-merchant/v2/data/merchant.db`):

```js
SELECT value FROM station_info WHERE key = '...'
INSERT OR REPLACE INTO station_info (key, value) VALUES ('...', '...')
```

That table **does not exist** in the live schema. Verified read-only on
2026-06-08 against `merchant.db`:

- `station_info` — absent
- `settings` — absent
- `system_metadata` — **present**, identical key/value shape:
  ```sql
  CREATE TABLE system_metadata (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```

So `settings_write` fails for **every** valid key (it errors at the initial
`SELECT ... FROM station_info`). It only appeared healthy because its recently
recorded errors were the `allowed_keys` gate rejecting an out-of-list key
(`ALLOWED_IP`) *before* any SQL ran.

`station_info` was almost certainly renamed to `system_metadata` in BaanBaan's
schema, and COSA's tool was never updated.

## How it surfaced

The 2026-06-08 weekly report flagged `db_query` "no such table" errors for
`station_info`/`settings`. Those specific errors came from an orchestrator
session improvising queries while mishandling a mis-routed home-IP email, but
investigating them revealed the genuine `settings_write` mismatch.

## Open questions for the owner

1. Is `system_metadata` the correct, intended target for these operator/station
   keys (`operator_name`, `operator_email`, `timezone`, `station_notes`,
   `maintenance_mode`)?
2. **Does BaanBaan itself read `system_metadata`?** If so, COSA writing
   `maintenance_mode` (or any of these keys) into it could change BaanBaan
   behavior. This is the reason the tool was disabled rather than auto-repointed.
   Confirm the key namespace is safe for COSA to write, or scope COSA's keys
   (e.g. a `cosa.` prefix) to avoid collisions.
3. Note: `appliance.database.read_only: true` in `appliance.yaml`, yet
   `settings_write` opens a writable connection. Reconcile this — either the DB
   is genuinely read-only (retire the tool) or a writable carve-out is intended.

## Proposed fix (once confirmed)

- Make the target table configurable: `tools.settings_write.table`
  (default `system_metadata`), instead of the hardcoded `station_info`.
- Optionally namespace COSA-written keys to avoid colliding with BaanBaan's.
- Re-enable (`enabled: true`) and add a test asserting the configured table name
  is used in both the read and the `INSERT OR REPLACE`.

No BaanBaan code changes are required — this is entirely within COSA. The only
cross-system consideration is whether the *values* COSA writes are safe in a
BaanBaan-owned table (questions 1–2).
