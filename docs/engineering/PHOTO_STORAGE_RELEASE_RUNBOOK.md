# Photo storage: production release runbook (human-reviewed, NOT yet authorized)

Applies to `feat/photo-storage-production-completion`. Every step marked **[AUTH]** needs a separate owner authorization. Nothing in this runbook has been executed against staging or production.

## What this branch actually ships

| Area | State |
| --- | --- |
| Ownership tables | Registered: SQLite `schema.sql` via `ensureSchema`, and PostgreSQL `0040_photo_operation_ownership.sql`. Additive only. **Created automatically when the API starts on a database**, which happens on deploy, so deploying is itself the migration step |
| `PHOTO_OWNERSHIP_FENCING_ENABLED` | OFF unless exactly `"true"`. OFF keeps every existing behavior (full API suite 6,115 passed; one known Stripe timing flake that passes in isolation) |
| With the flag ON | W1/W2/W10 uploads → 503; W6 AI cleanup canonical delete, W7 distinct-root promotion, and W8/W9 delete/cleanup events → refused (outbox dead-letters with `PHOTO_FENCING_WRITER_NOT_ADOPTED`); W11 Instagram → retryable refusal. **W4 AI finalization keeps writing unfenced**, because the fenced writer is not wired (see below) |
| Fenced W4 writer | **BLOCKED.** Wiring the #406 capability into production roots and committing ownership inside the real finalization transaction was refused by the automated safety review. It needs explicit owner authorization. The validated design is in `proposed-photo-ownership/photoOwnershipAuthority.ts.proposal` and the disposable end-to-end harness `scripts/photo-final-readiness` |
| #390 24-MP memory | FAIL / BLOCKED (see `PHOTO_STORAGE_RELEASE_READINESS.md` §4) |

**Consequence:** turning the flag ON today pauses product uploads, Instagram preparation and canonical deletion without adding any fenced writer. It is an emergency stop for destructive paths, not a feature activation.

## 1. Backups and restore verification [AUTH for production]

- Take a DB backup: `npm run db:backup -w apps/api`.
- Take a photo backup: `npm run photos:backup -w apps/api`.
- Verify the DB restore with `db:restore-verify` and the photo manifest with `photos:recovery-verify <manifest>`.
- Record the hashes and the manifest key. Never use S3 backups as primary storage, and never delete backup objects for recovery.

## 2. Migration order

1. Confirm `origin/main`'s highest PostgreSQL migration. The Etsy `0039` must not collide; this branch uses `0040`. If `main` has moved past `0040`, renumber **this** file before merge. Never renumber an applied file.
2. **SQLite (production):** deploying the code runs `ensureSchema`, which creates the four tables (`CREATE TABLE IF NOT EXISTS`). There is no separate migration command, so step 1 (backup) must precede the deploy.
3. **PostgreSQL** (not primary today): apply `0040` in a transaction after `0038`/`0039`.

## 3. Deploy default-OFF code [AUTH]

Deploy with `PHOTO_OWNERSHIP_FENCING_ENABLED` unset. Expected behavior is identical to today, plus four empty tables.

## 4. Old instances and workers [AUTH, BLOCKED without platform access]

- Confirm in the Render dashboard or deploy log that the previous instance stopped before the new one started. With a persistent disk attached, Render runs a single instance and does not overlap deploys; **verify this for the actual service**.
- List every service with access to `PRODUCT_PHOTO_DIR` (API, any worker or cron). Outbox dispatch runs inside the API process, triggered by the scheduler.
- **Gate:** unknown instances mean STOP.

## 5. Outbox drain and unsafe deletion events

- With the flag ON, delete and cleanup events are dead-lettered with `PHOTO_FENCING_WRITER_NOT_ADOPTED`. Nothing is deleted.
- Operators review dead letters one by one. They never bulk-retry them while canonical keys may have been re-published.

## 6. DB and filesystem ownership verification

- Run the read-only recovery classifier (`developmentPhotoRecovery`, development harness today) against a copy of the production DB and disk. Production execution of the classifier is not implemented.
- Expect `reviewRequired=false` before any later activation.

## 7. Capacity checks

- **Disk:** the free-space floor must cover the DB, WAL and backups. The capability reserves 64–84 MiB per in-flight attempt and retains 10.7–17.2 MiB per success.
- **RAM:** #390 must pass at 384 MiB (it currently fails at 24 MP).

## 8. Staging acceptance [AUTH]

Repeat steps 1–7 on staging. Run the full CI suite and the Linux 512-MiB workflow on the staging build. Do not proceed on a failure.

## 9. Rollback and forward recovery

- **Flag:** unset it and restart; behavior returns to legacy.
- **Code:** redeploy the previous build. The tables remain and older code ignores them.
- **Schema:** drop the tables only if `ownershipRollbackBlockers` (`OWNERSHIP_ROLLBACK_BLOCKERS_SQL`) reports `safe`. Otherwise forward-fix.
- Media is never deleted by any rollback.

## 10. Monitoring and emergency stop

- Alert on dead letters with `PHOTO_FENCING_WRITER_NOT_ADOPTED`, upload 503s with the same code, disk free-space floor breaches, and OOM or exit 137.
- Emergency stop: set `PHOTO_OWNERSHIP_FENCING_ENABLED=true` and restart. This pauses destructive photo paths; uploads also pause.

## 11. Production activation [AUTH; currently BLOCKED]

Activation needs, in order:
1. the fenced W4 writer wired (authorization required);
2. W2 staged upload adopted (needs a request-stable operation ID and path-fed input);
3. #390 passing;
4. step 4 verified.

## 12. Post-activation verification

- Check that `photo_operations` reach `committed` for new finalizations, with `review` = 0.
- Check that canonical file hashes are unchanged for existing photos.
- Check that no dead letters are unexpected.
- Run the recovery classifier with no review items.
