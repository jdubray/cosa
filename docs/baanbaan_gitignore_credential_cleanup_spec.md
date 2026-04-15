# Spec: .gitignore hardening and e2e artifact cleanup

**Requested by:** COSA credential audit (alert IPS-1776279610276, 2026-04-15)
**Hand to:** BaanBaan development agent
**Priority:** High

---

## Context

COSA ran a credential audit on the `baan-baan-merchant` repo and flagged 59 findings.
Most are false positives (see "No-action items" below), but two real issues require repo changes.

---

## Required changes

### 1 — Remove `v2/e2e/gift-card-debug-results.json` from git history

**File:** `v2/e2e/gift-card-debug-results.json`  
**Why:** This file is currently tracked in git. It contains:
- A bearer token URL: `bearer_token=MDE5ZDA5MDItZjIzNS03NjgzLWFhYWMtZGZkNzcxNzRjOGQyLUNIRUNLT1VUX0ZPUk0=`
  (decodes to a UUID-style sandbox session token for `sandbox-payments-checkout.com`)
- Font Awesome kit token `31c510a5f6`

The tokens are from a sandbox/test environment, not production. However, test artifacts containing any tokens or session data should not be committed.

**Action:**
1. Remove the file from the working tree: `git rm v2/e2e/gift-card-debug-results.json`
2. Add `v2/e2e/*.json` to `.gitignore` so future Playwright JSON output artifacts are never committed
3. Commit both changes

If the file appears in older commits and the team wants to scrub history, use `git filter-repo --path v2/e2e/gift-card-debug-results.json --invert-paths`. Otherwise a plain `git rm` + gitignore is sufficient given these are sandbox tokens.

---

### 2 — Add `secrets/` to `.gitignore`

**Why:** The root `.gitignore` (at `/home/baanbaan/baan-baan-merchant/.gitignore`) has no entry for a `secrets/` directory. No such directory exists today, but the gap means if anyone creates `secrets/` it will be silently included in commits.

**Action:** Add the following to `.gitignore`:

```
# Secret files — never commit
secrets/
*.pem
*.key
*.p12
*.pfx
```

---

## No-action items (confirmed false positives)

These were flagged by the scanner but are **not real credential exposures**:

| File | Pattern | Why it's a false positive |
|------|---------|--------------------------|
| `v2/public/js/app.js` | `password_assignment` | JS state variables initialised to `null` and populated from form inputs; cleared after use (line 716). Not hardcoded credentials. |
| `v2/src/routes/merchants.ts` | `password_assignment`, `base64_secret` | Receipt email password is user-supplied config; webhook secret uses `randomBytes(32)` + AES-256-GCM encryption. Correct pattern. |
| `v2/test/backup.test.ts:270` | `aws_access_key` | `AKIAIOSFODNN7EXAMPLE` is the canonical AWS documentation example key, intentionally non-functional. Already suppressed in COSA config. |

---

## Acceptance criteria

- [ ] `git ls-files v2/e2e/gift-card-debug-results.json` returns empty (file untracked)
- [ ] `v2/e2e/*.json` is listed in `.gitignore`
- [ ] `secrets/` is listed in `.gitignore`
- [ ] COSA credential audit runs clean on next check (no new IPS alert)
