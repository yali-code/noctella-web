# SQLite Database Backup and Restore Verification

## Scope and architecture

Sprint 124 protects the SQLite database only. Product photos remain on the API persistent disk
and require separate off-disk protection. This feature is not a complete disaster-recovery or
production-readiness claim.

```text
Render cron (daily at 03:00 UTC)
→ authenticated API request
→ Database Backup Service
→ Database Backup UseCase
→ S3-compatible Database Backup Repository
```

The cron process has no persistent disk and no S3 credentials. It never opens or copies SQLite;
the API-owned `better-sqlite3` connection creates the consistent backup through SQLite's online
backup mechanism.

## Configuration

Configure these server-only values on the API service. They are required only when backup or
restore verification is invoked, not for normal API startup:

- `DATABASE_BACKUP_S3_ENDPOINT` (optional for services using their standard regional endpoint)
- `DATABASE_BACKUP_S3_REGION`
- `DATABASE_BACKUP_S3_BUCKET`
- `DATABASE_BACKUP_S3_ACCESS_KEY_ID`
- `DATABASE_BACKUP_S3_SECRET_ACCESS_KEY`
- `DATABASE_BACKUP_S3_PREFIX` (optional; defaults to `database-backups`)
- `DATABASE_BACKUP_S3_FORCE_PATH_STYLE` (optional; set to `true` only when required)

Never place real values in repository files. Configure an external destination lifecycle policy
before production use; the application never lists or deletes old backups.

## Automated and manual backup

Render invokes the authenticated API backup endpoint daily with cron `0 3 * * *` (03:00 UTC).
The existing unrelated background-job cron remains hourly.

For an operator-triggered run, set `API_HOSTPORT` and `SCHEDULER_AUTH_TOKEN` for the running API and
run:

```text
npm run db:backup -w apps/api
```

The operation creates a temporary consistent artifact, requires `PRAGMA integrity_check = ok`,
calculates SHA-256 and byte size, uploads it, verifies remote metadata, downloads it to a second
new temporary path, and repeats SHA-256 and SQLite integrity validation. Any mismatch fails the
operation; temporary files are removed and the live database is never overwritten.

### Failure diagnostics (ADS-009F)

A failed run still returns a generic HTTP 503. The API also writes **one** JSON line to stderr, for
example:

```text
{"event":"database_backup_failed","stage":"STORAGE_UPLOAD","code":"STORAGE_AUTH_REJECTED","httpStatus":403,"errorName":"SignatureDoesNotMatch"}
```

The product-photo backup logs `product_photo_backup_failed` the same way.

- **What is logged:** only a stage, a fixed code, the numeric storage HTTP status and an
  allowlisted S3/network error name.
- **What is never logged:** messages, stacks, paths, object keys, bucket names, endpoints,
  credentials or provider response bodies.

| `code` | Usual cause to check |
|---|---|
| `CONFIG_MISSING_OR_INVALID` | Region, bucket, access key ID or secret is empty (R2 needs `REGION=auto`), or the prefix is invalid |
| `STORAGE_AUTH_REJECTED` | Wrong key pair (e.g. an API *token value* used instead of the S3 *Secret Access Key*), or a token without Object Read & Write on that bucket |
| `STORAGE_BUCKET_NOT_FOUND` | Bucket name mismatch, or a jurisdiction endpoint mismatch (e.g. an EU bucket needs the `.eu.` R2 endpoint) |
| `STORAGE_BAD_REQUEST` / `STORAGE_NOT_IMPLEMENTED` at `STORAGE_UPLOAD` | Region/endpoint signing mismatch, or the provider rejecting the SDK's default streaming checksum on uploads |
| `STORAGE_ENDPOINT_UNREACHABLE` | Malformed or unreachable endpoint URL |
| `LOCAL_SOURCE_FAILED` (`LOCAL_SNAPSHOT` / `LOCAL_FILE` / `LOCAL_DB_READ`) | Disk or SQLite access, or a photo file missing or changed on disk |

## Restore verification

Restore verification validates one explicit remote object without restoring it into service:

```text
npm run db:restore-verify -w apps/api -- <object-key>
```

The command downloads only to a new temporary path, validates remote SHA-256 metadata and byte
size, runs SQLite integrity checking, reports safe metadata, and removes the temporary artifact.
It never changes `DATABASE_URL`, runs migrations, replaces the live database, or deletes a remote
object.

**Restore verification is not a production restore.** A tested disaster-recovery cutover remains
separate work. Backup failures must be treated as operational failures, and destination retention
remains controlled exclusively by the external object-storage lifecycle policy.
