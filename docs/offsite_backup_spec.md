# Offsite Backup Spec

**Status:** draft
**Author:** COSA debug session, 2026-05-09
**Supersedes:** Item #3 from `memory/project_open_items.md` (2026-04-20)

## Problem

Today's nightly backup (cron `backup_run`, 03:00 local) writes 9 JSONL files plus
SHA-256 sidecars to `/tmp/cosa-backups/` **on the BaanBaan appliance**. The
appliance's `/tmp` is a `tmpfs` (RAM-backed):

```
tmpfs on /tmp type tmpfs (rw,nosuid,nodev,size=2073456k,nr_inodes=1048576)
```

Three failure modes follow from this:

1. **Reboot wipes the backup history.** Any appliance restart (planned or
   crash) loses every `.jsonl` and every sidecar in one event.
2. **Single-point-of-failure.** Backups live on the same appliance whose DB
   they back up. A disk failure, theft, fire, or ransomware that takes out the
   appliance also destroys every recovery copy.
3. **No retention beyond appliance uptime.** The `q /tmp ... 10d` tmpfiles
   policy is moot when reboots reset the clock anyway.

There is no offsite copy. The only S3 reference in the codebase is
`s3_access_key` in `src/tools/token-rotation-remind.js` — a rotation reminder
for a credential that no backup tool actually consumes.

## Goals

- **Durability:** survive any single appliance failure (disk, reboot, theft).
- **Encryption at rest:** backups contain PII (orders, payments, employees,
  reservations) — must be encrypted with a key not stored on the appliance.
- **Retention:** 30 days of nightly backups, plus the first-of-month for 12
  months. (Existing in-RAM retention is effectively zero.)
- **Verifiability:** the existing SHA-256 sidecar workflow continues to work
  end-to-end; verification can run against the offsite copy without rehydrating.
- **Operational fit:** runs from the cosa server's nightly cron (already
  triggers `backup_run`); no new always-on services on the appliance.
- **Quiet failure modes:** offsite-copy failure raises a `backup-offsite`
  alert, distinct from `backup-run` and `backup-verify` (the cron-scheduler
  recently split these categories — preserve that separation).

## Approach options

### A. Per-table push to S3 (boto/aws-sdk)

After `backup_run` completes, the cron task uploads each `*.jsonl` and its
`.sha256` to a versioned, lifecycle-policied S3 bucket (or B2/R2 equivalent).
Use SSE-KMS or client-side encryption.

- **Pros:** mature, lifecycle rules handle retention, S3 Object Lock can give
  WORM ransomware protection.
- **Cons:** key management — the upload key must live somewhere the cosa
  server can reach. Adds an SDK dependency (`@aws-sdk/client-s3`).

### B. `restic` to a remote repo (S3, B2, SFTP)

Run `restic backup /tmp/cosa-backups/` from the cosa server (which already SSHes
into the appliance) after `backup_run` finishes.

- **Pros:** dedup + encryption baked in; trivial retention via `forget`/`prune`;
  one binary, no SDK.
- **Cons:** restic state lives in the remote repo — recovery is a CLI dance;
  COSA's SHA-256 verify workflow becomes redundant with restic's own checks.

### C. BaanBaan-native backup endpoint

Per item #3 of the 2026-04-20 open list: the appliance exposes
`GET /api/merchants/:id/backup?type=full`. Have the cron call that endpoint
via `appliance_api_call`, write the response to the cosa server's local disk
(persistent), and push to S3 from there.

- **Pros:** removes COSA's schema coupling (today the backup script enumerates
  tables from `appliance.yaml`); single round-trip; the appliance owns the
  schema.
- **Cons:** depends on a BaanBaan endpoint we don't control; per the
  BaanBaan-policy memory, COSA cannot ask for changes to that endpoint
  (specs go in `cosa/docs/`, someone else implements there).

## Recommendation

**Hybrid: A first, C later.**

1. **Now (this PR):** add S3 upload as a step _after_ `backup_run` completes
   in `runBackupTask`. Keeps the existing `backup_run` tool untouched and the
   on-appliance JSONL workflow intact. Closes the durability gap immediately.
2. **Later (after BaanBaan endpoint exists):** migrate the source-of-backup
   from "JSONL exports the appliance" to "BaanBaan native dump endpoint",
   keeping the same S3 upload step. This is the strategic direction in the
   open-items list.

`restic` (option B) is tempting but conflicts with the existing per-file
SHA-256 sidecar pattern that `backup_verify` already uses; introducing it
would require either deprecating `backup_verify` or running both flows in
parallel. Skipping for now.

## Implementation outline (option A)

### Config additions (`config/appliance.yaml`)

```yaml
appliance:
  tools:
    backup_run:
      # existing ...
      offsite:
        enabled: true
        provider: s3        # or "b2", "r2"
        bucket:   "hanuman-cosa-backups"
        prefix:   "appliance/"   # → s3://bucket/appliance/<file>
        region:   "us-east-1"
        # SSE-KMS key alias, or "none" for client-side encryption.
        sse_kms_alias: "alias/cosa-backups"
        # Credential keys (lookup via the existing credential store).
        access_key_credential_key: "s3_access_key"
        secret_key_credential_key: "s3_secret_key"
        # Soft cap — alert (not throw) above this.
        max_upload_seconds: 60
```

### Code

- New tool: `src/tools/backup-offsite-push.js`. Accepts an array of
  `{ path, checksum }` (the `backup_files` array `backup_run` already
  returns) plus the run timestamp. Uploads each `*.jsonl` and `*.sha256`
  with `If-None-Match: *` (idempotent). Returns
  `{ success, uploaded: [...], skipped: [...], errors: [...] }`.
- `runBackupTask` in `cron-scheduler.js`: after the existing
  "Backup complete" log line, if `offsite.enabled`, call the new tool with
  `backupResult.backup_files`; on failure, raise a `backup-offsite` alert
  via the same `createAlert` + `emailGateway.sendEmail` path used today.
- New cron category constant: `BACKUP_OFFSITE_CATEGORY = 'backup-offsite'`.
  Add to the alert dedup categories already split in `cron-scheduler.js`.
- `s3_access_key` and `s3_secret_key` move from rotation-reminder-only to
  actually-consumed credentials. The rotation reminder in
  `src/tools/token-rotation-remind.js` already covers the 90-day cadence.

### Tests

- `tests/tools/backup-offsite-push.test.js`: unit tests with a mocked S3
  client covering: success, partial-upload (some files fail), credential
  missing, network timeout, idempotent retry.
- Integration: extend `tests/phase2/t-2.1-backup-automation.test.js` with a
  case that asserts the offsite step runs after `backup_run` succeeds and is
  skipped when `offsite.enabled` is false.

### Roll-out

1. Provision the bucket with versioning, Object Lock (governance, 30d), and a
   lifecycle rule: transition to Glacier after 90d, expire after 366d.
2. Provision a least-privilege IAM user with `s3:PutObject`,
   `s3:PutObjectAcl` (if needed), `s3:ListBucket` on the prefix only —
   no `GetObject` or `DeleteObject`. (Restoration is a manual process by
   design; the cosa server should not be able to delete its own backups.)
3. Store the IAM keys in the cosa server's credential store; update
   `appliance.yaml` with the alias names; restart `cosa.service`.
4. Wait one nightly cycle, verify uploads in S3 console + cron log shows
   `Backup offsite push complete: 9 files, X bytes`.
5. Tag a release once the first successful upload is confirmed.

## Open questions

- **Provider:** S3 vs Backblaze B2 vs Cloudflare R2 — cost differs by ~3×; B2
  is cheapest for this volume (~12MB/night × 30 = 360MB/month). User to
  decide.
- **Bucket ownership:** new bucket dedicated to cosa, or a sub-prefix in an
  existing Hanuman bucket?
- **Retention beyond 12 months:** legal/compliance requirements for
  payment-related logs may require longer. Confirm with the user before
  finalising the lifecycle rule.

## Non-goals

- Restoration tooling. Recovery is rare and manual; we don't need a
  one-button restore today. A future spec can add `backup_restore`.
- Continuous replication / streaming WAL. Nightly snapshots are sufficient for
  the cafe's RPO.
- Backing up COSA's own state (session-store, alerts DB). Out of scope; that
  data is recoverable from the appliance and the running tunnel.
