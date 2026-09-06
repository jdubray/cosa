# Spec: Processor-fee backfill has been dead since 2026-07-08 (and cannot self-heal)

**Status:** Proposed
**Target:** BaanBaan POS (`/home/baanbaan/baan-baan-merchant/v2`)
**Author:** COSA monitoring (spec only — BaanBaan maintainer implements)
**Date:** 2026-09-06
**Severity:** High (merchant fee/net-revenue reporting is wrong for ~2 months and silently degrading)

> Per the COSA/BaanBaan separation policy, COSA does not modify BaanBaan code
> or data. This documents the diagnosis and the fix; a BaanBaan maintainer
> implements it. COSA's investigation was read-only (`sqlite3 -readonly`,
> journal reads, source reads).

---

## 1. Symptom

Every `[processor-fees]` sweep logs the same line, on every run, for at least
the past four days:

```
Sweep complete: 5 filled, 500 still pending, 0 errored
Sweep complete: 2 filled, 500 still pending, 0 errored
Sweep complete: 0 filled, 500 still pending, 0 errored
```

`500` is not a real backlog figure — it is the query's `LIMIT 500` saturating.
Nothing errors, so nothing alerts.

## 2. Actual state (measured 2026-09-06)

`payments` table, merchant `m_69c917c12c234519`:

| | count |
|---|---|
| total payments | 4,014 |
| `processor_fee_cents IS NULL` | **1,836 (46%)** |
| of those, card payments *with* a `finix_transfer_id` (i.e. genuinely fillable) | **1,627** |

Coverage by month, restricted to rows that have a `finix_transfer_id`:

| month | filled | missing |
|---|---|---|
| 2026-03 | 32 | 0 |
| 2026-04 | 425 | 0 |
| 2026-05 | 793 | 0 |
| 2026-06 | 754 | 0 |
| 2026-07 | 174 | 622 |
| 2026-08 | **0** | **862** |
| 2026-09 | **0** | **143** |

Daily resolution puts the break at **2026-07-08**: fees filled normally every
day through 2026-07-08 mid-day, then stopped. Only three isolated successes
since (2026-07-15, 07-19, 07-25 — one row each).

The remaining 209 NULL rows are legitimately unfillable and should be ignored:
183 `cash`, 24 `clover`, 2 `gift_card`.

## 3. Root cause — two independent defects

### 3a. The fee lookup itself stopped returning data (primary)

`src/services/processor-fees.ts:160` calls
`listFeesByTransfer(creds, transferId)`, which (`src/adapters/finix.ts:642`)
issues:

```
GET /fees?linked_to=<transferId>&limit=100
```

and returns `settled: count > 0`. A row is only written when at least one fee
record comes back; an empty list leaves the row NULL for the next sweep.

The sweep reports `0 errored`, so the HTTP calls are **succeeding and coming
back empty**. The transfers themselves are fine (these are ordinary completed
card-present sales). Something about how fees are linked changed on the Finix
side around 2026-07-08 — most likely fee records are no longer linked to the
transfer via `linked_to` (e.g. they now hang off the settlement entry, or the
account moved to a blended/settlement-level fee model). This needs confirming
against the Finix dashboard or a manual `GET /fees?linked_to=…` for one known
2026-08 transfer before choosing a fix.

**Fix:** re-establish the correct fee lookup for the current Finix
configuration. If fees are now settlement-scoped, walk
`/settlements/:id/funding_transfers` (or `/fees?settlement_id=…`) and attribute
back to the transfer rather than querying `linked_to` per transfer.

### 3b. The sweep can never drain the backlog (structural — fix regardless)

`src/services/processor-fees.ts:88-99`:

```sql
SELECT ... FROM payments
 WHERE processor_fee_cents IS NULL
   AND finix_transfer_id IS NOT NULL AND finix_transfer_id != ''
   AND created_at < datetime('now','-24 hours')
 ORDER BY created_at ASC
 LIMIT 500
```

Oldest-first with a hard `LIMIT 500` means a permanently-unfillable prefix
causes **head-of-line blocking**: the window is currently pinned to
**2026-07-08 → 2026-07-27**, and every payment after 2026-07-27 has never been
attempted even once. Fixing 3a alone would still leave the sweep grinding
through the same 500 rows a day at a time.

Compounding it, `startProcessorFeeSweep()` re-runs 60s after every process
start (`:212`) and then every 24h. `baanbaan.service` restarts fairly often —
the `internet_ip_watch` recovery restarted it at 08:54 today — so in practice
the sweep re-runs the *same* oldest 500 more frequently, and never advances.

**Fix (all three):**
1. Add an attempt counter / `fee_fetch_attempts` (or `fee_last_attempt_at`)
   column and order by it, so rows that keep coming back empty fall to the back
   of the queue instead of blocking newer ones.
2. Give up permanently after N attempts or an age ceiling (e.g. > 60 days old,
   Finix fees are long settled by then) by writing `0` with an explicit
   `fee_unavailable` marker, so reports can distinguish "no fee" from "unknown".
3. Emit the true backlog in the completion log
   (`SELECT count(*)` without the LIMIT), so `500` stops masking `1,627`.

## 4. Why COSA did not catch this

The sweep logs at `info` and reports `0 errored`, so neither
`resource_threshold_monitor` nor the digest's error paths see anything. A
constant `500 still pending` is indistinguishable from a healthy queue at this
log level.

**COSA-side follow-up (COSA implements, not BaanBaan):** add an observation
monitor for fee coverage — e.g. `payments_missing_processor_fee_30d`, alerting
when card payments with a transfer ID and older than 48h remain NULL. That
would have fired on 2026-07-10.

## 5. Merchant impact

The dashboard payments tab and the reports in `src/routes/reports.ts` compute
effective per-transaction cost from `processor_fee_cents`. For 2026-08 and
2026-09 that column is NULL for **every** card sale, so any net-revenue or
effective-rate figure covering those months is understated cost / overstated
net. Backfilling is still possible — Finix retains fee records — but the fee
lookup (3a) has to be fixed first.

## 6. Verification after the fix

```sql
-- expect 0 for any month after the fix + one full sweep
SELECT substr(created_at,1,7) m, sum(processor_fee_cents IS NULL) missing
  FROM payments WHERE finix_transfer_id IS NOT NULL
 GROUP BY m ORDER BY m DESC;
```

And the sweep log should report a real, shrinking backlog rather than a
constant `500`.
