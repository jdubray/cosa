# Shift Report Reconciliation Spec

**Status:** Draft
**Date:** 2026-04-26
**Owner:** cosa
**Scope:** `src/tools/shift-report.js`, `src/cron-scheduler.js`, `tests/phase2/t-2.2-shift-report.test.js`
**Out of scope:** BaanBaan appliance code at `/home/baanbaan/baan-baan-merchant/v2` — **DO NOT MODIFY UNDER ANY CIRCUMSTANCES**. This fix is entirely cosa-side; we read the appliance DB read-only as we already do.

---

## 1. Problem

Nightly shift-report email materially undercounts both order count and revenue versus the in-cafe POS dashboard.

Observed for the period **2026-04-25 13:00 UTC → 2026-04-26 13:00 UTC**:

| Metric              | Email reported | POS dashboard / DB truth | Δ        |
|---------------------|----------------|--------------------------|----------|
| Orders — total      | 13             | 27                       | -14      |
| Orders — completed  | 0              | 27 (all `paid`)          | -27      |
| Orders — cancelled  | 0              | 0                        | 0        |
| Orders — active     | 0              | 0                        | 0        |
| Payments count      | 16             | 28                       | -12      |
| Revenue total       | $1,133.60      | $1,860.07                | -$726.47 |

## 2. Root causes (verified against `merchant.db` 2026-04-26)

### 2.1 Timestamp format mismatch — primary undercount
- `orders.created_at`, `payments.created_at`, `payment_errors.occurred_at`, `timesheets.clock_in` are all stored by SQLite `datetime('now')` in space format: `'2026-04-25 18:35:11'` (333/333 sampled rows).
- The shift-report SQL filters with ISO format from JS `Date.toISOString()`: `>= '2026-04-25T13:00:00.000Z'`.
- These compare **lexicographically as TEXT**. At char 11, `' '` (0x20) < `'T'` (0x54), so every row from `'2026-04-25 ...'` sorts below the lower bound `'2026-04-25T...Z'` and is silently dropped.
- Net effect on the 24h email window: rows from the start UTC date are excluded entirely; only rows whose date string matches the end UTC date pass through. The bulk of yesterday's business day in `America/Los_Angeles` falls on the start UTC date and disappears.
- Same defect applies to the orders, payments, payment_errors, and staff queries.

Confirmation:
```
EXACT WINDOW with current SQL : 13 paid orders
SAME WINDOW via datetime() cast: 27 paid orders
```

### 2.2 Order-status breakdown drops `paid` (and three more)
Current CASE branches: `completed | cancelled | (confirmed|preparing|ready)`.
Legal status set in DB CHECK constraint:
`pending_payment, received, submitted, confirmed, preparing, ready, picked_up, completed, cancelled, pos_error, paid, refunded`.

Statuses never bucketed: `pending_payment, received, submitted, picked_up, pos_error, paid, refunded`.
`paid` is the dominant terminal state (27 / 27 today). Result: total > 0 but every breakdown bucket = 0.

### 2.3 Revenue total omits `service_charge_cents`
- `payments.amount_cents` already contains subtotal + tax + tip (+ amex surcharge); confirmed payments sum for 24h = $1,826.67.
- POS dashboard total = $1,860.07. Δ = $33.40 = `SUM(orders.service_charge_cents)` for the same window.
- Service charge is stored only on `orders`, never copied into `payments`.

## 3. Fix — cosa-side only

### 3.1 Window comparison
Wrap both sides in `datetime(...)` so format normalization is enforced by SQLite, then pass bounds in space format `'YYYY-MM-DD HH:MM:SS'` (UTC).

```sql
WHERE datetime(col) >= datetime('2026-04-25 13:00:00')
  AND datetime(col) <  datetime('2026-04-26 13:00:00')
```

Notes:
- Switch the upper bound from `<=` to `<` to make the window half-open and remove the millisecond-boundary fudge.
- Apply identically to `buildOrdersQuery`, `buildRevenueQuery`, `buildPaymentErrorsQuery`, `buildStaffQuery` (the last uses `clock_in` / `clock_out`).
- `buildWindow()` returns the bounds as space-format UTC strings instead of ISO. Move format conversion into `buildWindow()` so the SQL builders don't need to know.

### 3.2 Status buckets (new canonical mapping)
Using the DB's own status set:

| Bucket             | Statuses                                                              |
|--------------------|-----------------------------------------------------------------------|
| `paid`             | `paid`, `completed`, `picked_up`                                      |
| `cancelled`        | `cancelled`, `pos_error`                                              |
| `refunded`         | `refunded`                                                            |
| `active`           | `pending_payment`, `received`, `submitted`, `confirmed`, `preparing`, `ready` |

Invariant: `paid + cancelled + refunded + active == total_orders`. Add a runtime assertion in `handler()` that logs (does not throw) if the invariant fails — surfaces unknown-status drift if BaanBaan ever extends the CHECK constraint.

`shift_report` return shape gains `refunded`:
```js
orders: { total, paid, cancelled, refunded, active }
```

### 3.3 Revenue
Add a fifth query (or extend the orders query) that sums `service_charge_cents`, `tip_cents`, and `discount_cents` from `orders` for the same window, then:

```js
revenue: {
  payment_count,                 // from payments (unchanged semantics)
  payments_total,                // SUM(payments.amount_cents)
  service_charge_total,          // SUM(orders.service_charge_cents)
  total: payments_total + service_charge_total,
  avg_order_value: total / non-zero order count,
  currency: 'USD',
}
```

`avg_order_value` denominator changes from `payment_count` (which double-counts split tenders) to count of orders whose status ∈ paid bucket, so two-card splits stop halving the average.

### 3.4 Email body (`formatShiftReportBody` in `src/cron-scheduler.js`)
Update labels to match the new shape:

```
ORDERS
  Total:      27
  Paid:       27
  Cancelled:  0
  Refunded:   0
  Active:     0

REVENUE
  Payments:        28
  Payments total:  $1826.67 USD
  Service charge:  $33.40 USD
  Grand total:     $1860.07 USD
  Avg/order:       $68.89
```

### 3.5 Anomaly rules
`detectAnomalies()` already takes `cancelledOrders`; no logic change beyond renaming the field it pulls from `orders.paid_bucket_name`. Re-tune later if needed; not part of this spec.

## 4. Acceptance criteria

1. For the window 2026-04-25 13:00 UTC → 2026-04-26 13:00 UTC, the tool returns:
   - `orders.total === 27`
   - `orders.paid === 27`
   - `orders.cancelled === 0`, `orders.refunded === 0`, `orders.active === 0`
   - `revenue.payment_count === 28`
   - `revenue.payments_total === 1826.67`
   - `revenue.service_charge_total === 33.40`
   - `revenue.total === 1860.07`
2. Invariant `paid + cancelled + refunded + active === total` holds for any 1h, 24h, and 48h window over the last 7 days of data.
3. Re-running the cron job produces an email whose `ORDERS`/`REVENUE` sections render the values from (1).
4. T-2.2 integration test seeds (a) one order with `status='paid'` and `service_charge_cents=340`, (b) one with `status='cancelled'`, (c) one with `status='refunded'`, and asserts each bucket and the new revenue total.
5. The DB is opened **read-only** (existing `sqlite3 -readonly` flag is preserved). No writes against the appliance under any code path.

## 5. Non-goals

- Reconciling the cosa shift report against POS-provider settlement files (Finix transfer reconciliation lives elsewhere).
- Changing the BaanBaan schema, BaanBaan code, or BaanBaan timestamp format. The `datetime()` cast on the cosa side is the entire fix.
- Time-zone presentation. The window stays UTC-anchored; converting to `merchants.timezone` for display is a separate change.

## 6. Rollout

Single commit on `main`:
- `src/tools/shift-report.js` — query rewrites + return shape
- `src/cron-scheduler.js` — `formatShiftReportBody` label changes
- `tests/phase2/t-2.2-shift-report.test.js` — seeded fixture covers all four buckets + service charge
- `package.json` bump per existing tag-first policy is **not** part of this commit (versioning is tag-based).

After merge, manually trigger the shift-report cron once (or wait for next 13:00 UTC tick) and visually confirm against the merchant POS dashboard for the same window.
