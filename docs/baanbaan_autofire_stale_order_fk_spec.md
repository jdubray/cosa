# Spec: Fix the auto-fire interval crash on undeletable stale orders (FK)

**Status:** Proposed
**Target:** BaanBaan POS (`/home/baanbaan/baan-baan-merchant/v2`)
**Author:** COSA monitoring (spec only — BaanBaan maintainer implements)
**Date:** 2026-05-25
**Severity:** Medium (recurring error every 60s; silently disables reservation reminders)

> Per the COSA/BaanBaan separation policy, COSA does not modify BaanBaan code
> or data. This documents the diagnosis and the fix; a BaanBaan maintainer
> implements it. COSA's read-only investigation is summarised below.

---

## 1. Symptom

`baanbaan.service` logs this every 60 seconds, continuously:

```
[auto-fire] Interval check failed — SQLiteError: FOREIGN KEY constraint failed
```

Began **2026-05-26 00:05 UTC** (2026-05-25 17:05 PDT) and has not stopped.

## 2. Root cause (confirmed)

The auto-fire interval (`src/services/auto-fire.ts`, `startAutoFire()` ~line 600)
runs a fixed sequence inside **one** try/catch (line ~621):

```ts
checkDueOrders()            // has inner per-row try/catch
checkPendingCourseFires()   // has inner per-row try/catch
cleanupFiredCourses()
cleanupStaleOrders()        // ← throws here, NO inner try/catch
checkReservationReminders() // ← never runs when the line above throws
```

`cleanupStaleOrders()` (line ~317) deletes abandoned unpaid online orders
(line ~332):

```sql
DELETE FROM orders
WHERE status IN ('received', 'pending_payment')
  AND source = 'online'
  AND created_at < datetime('now', '-30 minutes')   -- STALE_ORDER_AGE_MINUTES
```

One matching order — **`ord_c3a6950ab9d6da3a`** (`pending_payment`, `online`,
created `2026-05-25 23:35:08 UTC`) — crossed the 30-minute threshold at
**00:05 UTC**, exactly when the errors began. The `DELETE` is **blocked by a
child foreign key**: the order has **1 `campaign_redemptions` row**, and that
FK has no cascade:

```sql
-- campaign_redemptions
order_id  TEXT NOT NULL REFERENCES orders(id)        -- default NO ACTION / RESTRICT
```

SQLite (with FK enforcement on) aborts the `DELETE` → `FOREIGN KEY constraint
failed`. Because `cleanupStaleOrders()` has no inner try/catch, the throw
propagates to the interval wrapper, which logs the line and skips the rest of
the tick. The stale order is never removed, so it re-triggers every 60s
**forever**.

Child FKs to `orders(id)` that can block the delete (no cascade, default
RESTRICT): **`campaign_redemptions`, `payments`, `refunds`**. The rest
(`pending_course_fires`, `order_split_sessions`, `customer_push_subscriptions`
→ CASCADE; `payment_errors`, `terminal_transactions`, `special_instruction_log`,
`coupon_*`, `feedback` → SET NULL) do not block.

## 3. Impact

1. **Reservation reminders silently stop.** `checkReservationReminders()` runs
   *after* `cleanupStaleOrders()` in the same try block, so it is skipped on
   every tick while this persists. (The startup run also skips
   `checkAdvanceOrderReminders()`.) This is the real functional harm — not just
   log noise.
2. **Log spam** every 60s into persistent journald (cap 500 MB).
3. The abandoned order is never garbage-collected, so the condition is
   self-perpetuating until the row is removed.

## 4. Fix

Two changes; do both.

### 4.1 Isolate each interval check (robustness — prevents the cascade)

Wrap each call in `startAutoFire()` in its own try/catch so one failing check
cannot skip the others:

```ts
for (const step of [checkDueOrders, checkPendingCourseFires, cleanupFiredCourses,
                    cleanupStaleOrders, checkReservationReminders]) {
  try { step() }
  catch (err) { logger.error('[auto-fire]', `${step.name} failed`, { err: String(err) }) }
}
```

This alone restores reservation reminders and makes a single bad order
non-fatal to the rest of the loop.

### 4.2 Make stale-order cleanup actually delete (root fix)

`cleanupStaleOrders()` must remove the order's blocking child rows before
deleting it, in a transaction. For an **abandoned unpaid** order it is correct
to release its campaign redemption (so the coupon/campaign use is freed):

```ts
db.transaction(() => {
  const stale = db.query(`SELECT id FROM orders WHERE status IN ('received','pending_payment')
    AND source='online' AND created_at < datetime('now','-${STALE_ORDER_AGE_MINUTES} minutes')`).all()
  for (const { id } of stale) {
    db.run(`DELETE FROM campaign_redemptions WHERE order_id = ?`, [id])  // release coupon use
    db.run(`DELETE FROM orders WHERE id = ?`, [id])
  }
})()
```

Guard rails:
- A `pending_payment`/`received` online order should have **no completed
  payment**; if `payments`/`refunds` rows exist for it, **skip** the order
  (do not delete financial records) and log a warning for manual review.
- Alternatively/additionally, add `ON DELETE CASCADE` to the
  `campaign_redemptions.order_id` FK via migration. Do **not** cascade-delete
  `payments`/`refunds` — those are an audit trail.

## 5. Immediate operational recovery (stops the bleeding now)

Independent of the code fix, clear the one stuck order so the loop recovers:

```sql
-- back up merchant.db first
DELETE FROM campaign_redemptions WHERE order_id = 'ord_c3a6950ab9d6da3a';
DELETE FROM orders               WHERE id       = 'ord_c3a6950ab9d6da3a';
```

(Confirm it is genuinely abandoned/unpaid first: `SELECT * FROM payments WHERE
order_id='ord_c3a6950ab9d6da3a'` → expected 0 rows.)

## 6. Acceptance criteria

- [ ] A stale unpaid online order with a `campaign_redemptions` row is deleted
      cleanly; no `FOREIGN KEY constraint failed` is logged.
- [ ] A failure in any one interval check no longer prevents the others from
      running (reservation reminders fire even if stale-order cleanup errors).
- [ ] An abandoned order's campaign redemption is released; orders with real
      payments are skipped, not deleted.
- [ ] The `[auto-fire] Interval check failed` log line stops recurring.

## 7. Tests (BaanBaan side)

- Stale `pending_payment` online order + a `campaign_redemptions` row → cleanup
  deletes both, no error.
- Stale order + a `payments` row → cleanup **skips** it, logs a warning, no
  financial row deleted.
- One interval check throwing → subsequent checks (reservation reminders) still
  run.
- Regression: a normal paid order is never touched by `cleanupStaleOrders`.

---

## Addendum (2026-09-06): the same FK also breaks the manual delete endpoint

The fix above scopes to `cleanupStaleOrders()` inside the auto-fire interval.
A second, independent call path hits the identical constraint and is **not**
covered by it:

```
Sep 05 21:10:28  PATCH /api/merchants/m_.../orders/ord_97a131b3cb5683c5  409
Sep 05 21:10:30  PATCH /api/merchants/m_.../orders/ord_97a131b3cb5683c5  409
Sep 05 21:10:34  DELETE /api/merchants/m_.../orders/ord_97a131b3cb5683c5
                 SQLiteError: FOREIGN KEY constraint failed
```

`db.run('DELETE FROM orders WHERE id = ?')` at the delete route (~line 1072 of
the orders route module) has no child-row handling, so the request 500s and
staff get no usable error. Order `ord_97a131b3cb5683c5` (`cancelled`,
`dashboard`, $200.04, created 2026-09-06 03:02:48 UTC) is still undeletable;
it is referenced by `terminal_transactions` (1), `payments` (1) and
`order_split_sessions` (1).

Note this is a *different* child set than the auto-fire case
(`campaign_redemptions`), which means a per-table cascade patch aimed only at
`campaign_redemptions` will not fix it. The delete path needs either a
transactional cascade across all twelve tables with an `order_id` FK
(`terminal_transactions`, `payments`, `refunds`, `customer_push_subscriptions`,
`pending_course_fires`, `payment_errors`, `special_instruction_log`,
`campaign_redemptions`, `coupon_hash_redemptions`, `coupon_instances`,
`feedback`, `order_split_sessions`) or — better for a paid order — a soft
delete, since hard-deleting an order that has a real `payments` row destroys
financial history.

Recommended: reject the delete with a clear 409 when a `payments` row exists,
and soft-delete instead. Only genuinely abandoned unpaid orders should ever be
hard-deleted.
