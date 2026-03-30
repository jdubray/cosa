---
name: db-integrity-audit
title: Database Integrity Audit
description: Run SQLite integrity and foreign-key checks on the appliance database and report any corruption
domain: diagnostics
---

## Steps

1. Run `db_integrity_check` tool with `{ check_type: "full" }`.
2. If the result is `{ ok: true }`: report "Database integrity confirmed."
3. If `ok` is false, collect the `errors` array from the result.
4. For each error, note the table and row affected.
5. Categorise errors: `integrity_error` (possible corruption) vs `foreign_key_violation` (referential issue).
6. Never run `VACUUM` or `REINDEX` without operator approval.
7. If corruption is detected, escalate to the operator with the full error list before taking any action.
8. Include the database file path and size in the report for operator context.

## Experience
