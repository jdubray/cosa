# Spec: Remove Automatic Service Charge on Split Payments

**For:** BaanBaan development agent
**From:** COSA (operator: jdubray@gmail.com)
**Date:** 2026-04-16
**Supersedes:** Yesterday's (2026-04-15) request to lower the service charge rate to 18%. **Revert rate to 20%.** Rate change is withdrawn; this spec is behavioural only.
**Status:** New — scope is deliberately small

---

## Problem

When a check is split into multiple payments, the POS currently applies a service charge **automatically**. The operator wants this automatic application removed.

An **existing "Add service charge" action** is already available to servers, and that flow is **unchanged**. Servers already apply the charge at their discretion when appropriate; no new UI is needed.

## Business Rationale

The auto-apply-on-split rule has a false premise: that splitting the check is itself evidence of a party that should be charged. In practice, regulars in parties of 2–3 often split (one card each) and auto-charging them feels punitive.

The service charge is meant to compensate for the operational cost of many separate payments (typically 4+ splits). The server is best positioned to judge when that threshold applies, and the existing manual "Add service charge" action already covers that case.

## Required Change

Two items, both subtractive:

1. **Revert yesterday's rate change.** The service charge rate goes back to 20%. If the 18% change is not yet deployed, cancel it; if it is deployed, restore 20%. Remove every `18` / `0.18` / `"18%"` reference introduced by that PR.
2. **Remove the automatic service-charge application on split payments.** Whatever code path causes a service charge to be added implicitly during a split must be deleted. Splitting a check with no prior manual "Add service charge" action must produce zero service charge on all shares.

**Not changed:**
- The existing manual "Add service charge" action and its UI.
- The 20% rate the manual action applies.
- How the service charge is distributed across shares once manually applied.
- Reporting, tax, tip, and payment-processing logic.

## Out of Scope

- No new UI controls, toggles, or screens.
- No change to the manual "Add service charge" flow.
- No change to tax, tip, rounding, or payment-processing.
- No retroactive change to historical checks — already-closed checks keep whatever service charge they had.

---

## Acceptance Criteria

| # | Given | Then |
|---|-------|------|
| 1 | A check with no manual "Add service charge" action is split into 2 payments | **Zero service charge** on both shares |
| 2 | A check with no manual action is split into 4 payments | **Zero service charge** on any of the 4 shares |
| 3 | Server invokes the existing "Add service charge" action, then splits into 3 | Service charge is applied at **20%** and distributed across the 3 shares per existing (unchanged) split math |
| 4 | Server invokes "Add service charge" but does **not** split (single payment) | Service charge applied at **20%** on the single payment — identical to pre-change behaviour |
| 5 | A historical check closed before the deploy is reopened or reprinted | Its service charge is unchanged — no recalculation runs |
| 6 | Rate anywhere in code, config, or receipt templates | Always **20%**; no `18` / `0.18` / `"18%"` left behind |
| 7 | Reporting (daily/shift totals) is run after the deploy | Service-charge totals reflect only manually-applied charges. No ghost rows from the removed auto-path. |

---

## Tests

1. **Regression: split without manual action adds zero service charge** — for splits of 2, 3, 4, and 6 shares. This is the key test for the removed behaviour.
2. **Manual action still works** — invoking the existing "Add service charge" action applies 20% correctly on a single-payment check.
3. **Manual action + split** — applying service charge then splitting produces the same distribution as before the change.
4. **Grep the repo for 18% remnants** — a test or lint step that fails if `18` / `0.18` appears in any service-charge-related file.
5. **Historical fixture** — a closed check with an auto-applied service charge (created before the change) renders identically after the code change.

---

## Deployment & Verification

1. Before merging: grep source, config, and receipt templates for `18` and `0.18` in any service-charge context — zero matches expected. Note in the PR description that this was checked.
2. Deploy to the appliance. Hard-reload the POS if it is a PWA.
3. Live tests:
   - Open a 2-item check, split into 2 payments, confirm **no service charge** on either share.
   - Open another check, invoke "Add service charge" manually, split into 3, confirm 20% is applied and distributed.
   - Open a third check, invoke "Add service charge" manually without splitting, confirm 20% line is present.
4. Reply to the operator with confirmation (screenshots ideal).

This spec is POS-only — no COSA config changes needed. The shift-report tool reads service-charge totals from the DB unchanged.
