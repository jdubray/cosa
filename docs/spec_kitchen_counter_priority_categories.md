# Spec: Ticket Rendering — Priority Categories First

**For:** BaanBaan development agent
**From:** COSA (operator: jdubray@gmail.com)
**Date:** 2026-04-16
**Revised:** 2026-04-16 — broadened scope to both tickets; hardened pseudocode through multiple review passes
**Status:** Prior attempts unsuccessful — please confirm root cause before coding

---

## Glossary

| Term | Meaning |
|------|---------|
| **Kitchen counter view** | The tablet/monitor display the chefs read to know what to cook. Not a printed slip. |
| **Counter ticket** | The customer-facing ticket shown or printed at the front counter for the order taker / customer. |
| **Priority categories** | Appetizers, Salads, Soups — dishes that should be started first because of lead time. |
| **Line item** | One row on a ticket: a menu item, its quantity, and its modifiers. |

---

## Problem

On the kitchen counter view, dishes currently render in the order they were added to the order. Chefs have to scan the whole ticket to identify what to start first.

Three categories have long lead times and should be prepared immediately, so they must appear **at the top** of every ticket:

1. **Appetizers**
2. **Salads**
3. **Soups**

The operator has confirmed the counter ticket can use the **same ordering** — this simplifies implementation to one shared sort function applied by both renderers.

---

## Required Change

When rendering **any ticket** (kitchen counter view **and** counter ticket), group and sort the line items so that:

1. All items from the **Appetizers** category appear first.
2. Then all items from the **Salads** category.
3. Then all items from the **Soups** category.
4. Then all remaining items, in their existing order.

Within each priority category, preserve the current ordering (stable sort on rank).

**Use a single shared sort function imported by both renderers** so the two views never diverge.

If the BaanBaan agent identifies any **other rendering that drives cooking workflow** (e.g., a printed kitchen slip from a thermal printer, or a mobile cook view), that renderer should use the same helper. Before coding, please confirm the full list of in-scope renderers with the operator.

## Out of Scope

- The order of items in the order record (`orders` / `order_items` tables) is **not** changing. This is a **render-time** sort.
- No change to the API contract returned to the tablet — only the row order in the rendered ticket views.
- Line-item contents (quantity, modifiers) are preserved unchanged — sort reorders rows, nothing else.
- Other views (order history, reports, admin) are unchanged.

---

## Acceptance Criteria

Given an order with mixed categories, applied to **both** the kitchen counter view and the counter ticket (and any other in-scope ticket renderer):

| # | Given | Then |
|---|-------|------|
| 1 | Order contains 1 entrée, 1 appetizer, 1 soup | All tickets show: appetizer, soup, entrée (in that order) |
| 2 | Order contains 2 salads and 3 entrées | All tickets show: both salads first, then the 3 entrées |
| 3 | Order contains only entrées (no priority categories) | Row order matches pre-change behaviour — no items reordered |
| 4 | Order contains 1 appetizer, 1 salad, 1 soup, 1 entrée | Row order on every ticket is: appetizer → salad → soup → entrée |
| 5 | Order contains 2 appetizers added at different times | The 2 appetizers appear in their original add-order, both above any non-priority items |
| 6 | The same order is opened in both views | Row order is **identical** across the two views |
| 7 | Appetizer line has qty 3 and modifiers attached | Rendered as one row with qty=3 and modifiers intact — not split, not stripped |
| 8 | Adding a fourth priority category or renaming an existing one | Requires editing exactly **one** location (the priority-list config) and redeploying — no scattered string literals to chase |

## Non-Functional

- Sort must be stable. ES2019 (Node 12+) requires `Array.prototype.sort` to be stable, so relying on this is safe on the appliance runtime.
- Single source of truth: one helper file, imported by both renderers. Do **not** duplicate the priority list anywhere else.
- The helper must be covered by unit tests (see **Tests** below).
- Priority-list validation must fail loud on duplicates or missing entries at startup — never silently misrank.
- Helper must not throw at `require()` time; validation happens when configured priority IDs are passed in, not at module load (see pseudocode).

---

## Why prior attempts may have failed (investigation hints)

The operator has stated this feature has been attempted "several times" without success. Before coding, please investigate:

1. **Code path**: Which modules render each ticket? There may be multiple (kitchen view, counter view, printed slip). A fix applied to one renderer but not the others will look "broken" to the operator even if technically working in one place. Confirm **every** in-scope renderer is patched.
2. **Matching by ID vs name**: Matching by display name (`"Appetizers"`) is fragile — case differences, trailing whitespace, or a rename silently break the sort. **Prefer matching by `category_id` (FK).** See pseudocode below.
3. **Type coercion**: `Map` uses `SameValueZero` — the key `5` and the key `"5"` are distinct. If the DB column is integer but the priority list is committed with string literals (or vice versa), `Map.get()` silently returns `undefined`, every item falls to non-priority rank, and the sort no-ops with no error. Verify the `category_id` column type in the DB and commit priority IDs with the matching JS type.
4. **Field-name assumption**: The pseudocode assumes each line item exposes `.categoryId`. In BaanBaan the field may be `category_id` (snake_case), nested (`menuItem.categoryId`), or require a JOIN at render time. Verify the actual shape at the rendering layer and adjust the `keyOf` selector (see pseudocode) accordingly — do **not** copy-paste without checking.
5. **Sort stability**: ES2019 (Node 12+) mandates stable sort. This should not be an issue on the appliance — but if any polyfill or manual sort was used, verify stability.
6. **Caching / service worker**: If either view is served from a cached bundle or service worker, a deployed change may not be visible until a hard reload. Confirm the deploy invalidates cache; if a manual refresh is needed, instruct the operator.
7. **Scattered config**: If the priority list is duplicated across files, prior attempts likely updated one copy and left another behind. Enforce a single exported constant and import it everywhere.

Please report which of these (if any) was the blocker, so the COSA-side memory can be updated and future attempts avoid the same trap.

---

## Proposed Implementation

**Design principle:** a pure helper that accepts priority IDs as a parameter — no module-load-time throws, trivially unit-testable with arbitrary IDs, configuration lives separate from logic.

### `lib/ticket-ordering.js` (one file, one source of truth)

```js
'use strict';

/**
 * Build a rank Map from a priority-list array. Throws if the list is
 * misconfigured (duplicate entries, null/undefined entries, or not an array).
 *
 * Call this once at startup (or let ticketLineOrder build it per call on
 * small tickets where performance doesn't matter).
 */
function buildRank(priorityKeys) {
  if (!Array.isArray(priorityKeys)) {
    throw new Error('priorityKeys must be an array');
  }
  const m = new Map();
  priorityKeys.forEach((key, i) => {
    if (key == null) {
      throw new Error(`priorityKeys[${i}] is null/undefined`);
    }
    if (m.has(key)) {
      throw new Error(`Duplicate priority key: ${String(key)}`);
    }
    m.set(key, i);
  });
  return m;
}

/**
 * Sort ticket line items so priority-category items render first.
 *
 * @param items         - line items (not mutated; a shallow-copied, sorted array is returned)
 * @param priorityKeys  - category identifiers in priority order; index = rank
 * @param keyOf         - selector that extracts the category key from a line
 *                        item. Default: item => item.categoryId. Override this
 *                        if your line items use a different field name
 *                        (e.g. `item => item.category_id`, or a JOIN lookup).
 *
 * Stability: ES2019 (Node 12+) requires Array.prototype.sort to be stable,
 * so items within the same rank retain their original order. No tiebreaker
 * is needed in the comparator.
 */
function ticketLineOrder(items, priorityKeys, keyOf = (item) => item.categoryId) {
  const rank = buildRank(priorityKeys);
  const nonPriority = priorityKeys.length;
  return [...items].sort((a, b) => {
    const ra = rank.get(keyOf(a)) ?? nonPriority;
    const rb = rank.get(keyOf(b)) ?? nonPriority;
    return ra - rb;
  });
}

module.exports = { ticketLineOrder, buildRank };
```

### `config/ticket-rendering.js` (or existing config location — the point is: the priority list lives in configuration, not in the helper)

```js
'use strict';

// Priority category IDs — looked up once from the categories table and
// pinned here. IDs must match the DB column type (if category_id is INTEGER,
// commit numeric literals; if TEXT, commit string literals).
// In priority order: Appetizers → Salads → Soups.
const PRIORITY_CATEGORY_IDS = Object.freeze([
  /* Appetizers */  0, // TODO before merge: replace with real id from categories table
  /* Salads     */  0, // TODO
  /* Soups      */  0, // TODO
]);

module.exports = { PRIORITY_CATEGORY_IDS };
```

### Renderer call sites (both ticket views)

```js
const { ticketLineOrder } = require('../lib/ticket-ordering');
const { PRIORITY_CATEGORY_IDS } = require('../config/ticket-rendering');

// ...inside the render function, just before handing items to the template:
const sortedItems = ticketLineOrder(items, PRIORITY_CATEGORY_IDS);
```

If line items use a different field name than `categoryId`, override the selector:

```js
const sortedItems = ticketLineOrder(
  items,
  PRIORITY_CATEGORY_IDS,
  (item) => item.category_id, // or item.menuItem.categoryId, etc.
);
```

### Fallback — line items only have category **name**, no ID

Only use this if the rendering layer genuinely cannot access a category ID. Normalize to guard against casing and whitespace drift.

```js
// config/ticket-rendering.js
const PRIORITY_CATEGORY_NAMES = Object.freeze(['appetizers', 'salads', 'soups']); // lowercase
module.exports = { PRIORITY_CATEGORY_NAMES };
```

```js
// renderer
const { ticketLineOrder } = require('../lib/ticket-ordering');
const { PRIORITY_CATEGORY_NAMES } = require('../config/ticket-rendering');

const normalize = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

const sortedItems = ticketLineOrder(
  items,
  PRIORITY_CATEGORY_NAMES,
  (item) => normalize(item.category),
);
```

Name-based matching is documented as a **known silent-failure surface** (see hint #2). Use IDs when available.

---

## Tests (required)

Add a unit test file next to the helper. At minimum, cover:

1. **Priority first** — Items with priority category IDs appear before non-priority items.
2. **Priority ordering** — Output order is `Appetizers → Salads → Soups` regardless of input order.
3. **Stability (meaningful)** — Given **10 priority-A items** (call them A1..A10) interleaved with 5 non-priority items in a specific input order, the output must preserve A1..A10 in their original relative order (and the same for the non-priority group). Two-element stability tests are too weak — most unstable algorithms pass by accident on N=2.
4. **Pure non-priority** — An order with only non-priority items renders unchanged.
5. **Empty input** — `ticketLineOrder([], [1,2,3])` returns `[]`.
6. **Missing category key** — An item whose `categoryId` is `null` / `undefined` / not in the priority list is treated as non-priority (falls to the bottom group).
7. **Type-coercion sanity** — `ticketLineOrder([{categoryId: "5"}], [5])` (string vs number) must **not** rank the item as priority. This test documents the strict-equality behaviour so future maintainers see the trap.
8. **`buildRank` validation** — `buildRank([1, 2, 1])` throws (duplicate); `buildRank([1, null, 3])` throws (null); `buildRank(null)` throws (not-an-array); `buildRank([1,2,3])` succeeds. This replaces the old "module-load throws" test — validation is now explicit at the point of configuration, not at import.
9. **Does not mutate input** — `const items = [...]; ticketLineOrder(items, ids); expect(items).toEqual(originalOrder);`

Unit tests on the sort function are independent of any renderer caching or SW issues — they will catch bugs that prior attempts missed.

---

## Deployment & Verification

1. Before merging: fill in the real category IDs in `config/ticket-rendering.js`, replacing the `0` placeholders. The PR should **not** merge with placeholders — add this to the PR checklist.
2. Deploy to the appliance and confirm cache / service-worker invalidation. If the operator must hard-reload, say so explicitly in the handoff message.
3. Place a test order containing **one item from each priority category + one item from a non-priority category** (use any current menu items — e.g. one Appetizer, one Salad, one Soup, one entrée).
4. Expected on **every in-scope ticket view**: rows appear in the order `Appetizer → Salad → Soup → non-priority item`.
5. Place a second test order with only non-priority items; confirm row order is unchanged on all views.
6. Open both views for the same order side by side; confirm row order is **identical** (AC #6).
7. Reply to the operator with a short confirmation (screenshots of both views, or log excerpt) once verified.

After the BaanBaan agent confirms deploy, the operator will notify COSA. This spec is render-only — no COSA watchers depend on it, so no follow-up COSA-side config changes are needed.
