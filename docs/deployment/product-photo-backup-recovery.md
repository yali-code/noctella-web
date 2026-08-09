# Product Photo Backup and Recovery Verification

## Scope and architecture

Sprint 125 protects API-owned canonical ProductPhoto main and thumbnail files stored under
`PRODUCT_PHOTO_DIR`. Photo serving remains local and API-owned. External/unmanaged URLs, private
AI-intake staged photos, and unreferenced filesystem orphans are excluded.

```text
Render cron (daily at 04:30 UTC)
→ authenticated API request
→ Product Photo Backup Service
→ Product Photo Backup UseCase
→ separate S3-compatible Product Photo Backup Repository
```

The cron is HTTP-only. It has no disk, database path, photo path, or object-storage credentials.
The API enumerates bounded ProductPhoto reference pages and reads only safely contained regular
files selected by those references.

## Configuration

Configure `PRODUCT_PHOTO_BACKUP_S3_ENDPOINT`, `PRODUCT_PHOTO_BACKUP_S3_REGION`,
`PRODUCT_PHOTO_BACKUP_S3_BUCKET`, `PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID`,
`PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY`, `PRODUCT_PHOTO_BACKUP_S3_PREFIX`, and
`PRODUCT_PHOTO_BACKUP_S3_FORCE_PATH_STYLE` on the API only. Use a separate photo-backup bucket
and credentials. They are required only when backup or recovery verification runs.

## Backup behavior

The daily `30 4 * * *` trigger calls the API after the unchanged 03:00 UTC database backup.
An operator may trigger the same HTTP-only operation with:

```text
npm run photos:backup -w apps/api
```

Each local artifact is streamed to calculate actual byte size and SHA-256. Immutable objects use
`<prefix>/objects/<sha256>.webp`. Existing matching objects are reused; conflicting metadata fails
closed. Newly uploaded objects are downloaded to a new temporary path and verified.

Only after every expected artifact is remotely verified does the run publish and remotely verify
an immutable version-1 JSON manifest under `<prefix>/manifests/`. A failed run publishes no success
manifest, although already uploaded immutable objects may remain for safe reuse.

## Non-destructive retention

The application never deletes photo backup objects or manifests and configures no lifecycle expiry.
Content-addressed objects can remain referenced by current and later manifests indefinitely, so an
age-only expiry policy can delete the only remote copy of a still-current photo. Reference-aware
retention or garbage collection is future work.

## Recovery verification

Verify one explicit manifest and every object it references with:

```text
npm run photos:recovery-verify -w apps/api -- <manifest-key>
```

The command validates the key, metadata, byte sizes, SHA-256 values, and manifest structure. It
downloads sequentially into a newly created temporary directory, removes that directory afterward,
and never writes to `PRODUCT_PHOTO_DIR`, changes ProductPhoto rows, or deletes remote data.

Recovery verification is not a live production restore. Replacing the live photo directory and
coordinating a recovered database with a photo manifest remain separate operator-reviewed work.
