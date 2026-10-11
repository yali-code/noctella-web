# ADS-009C — Stage 1 staging isolation review (SQLite, Render, R2, schedulers, restore-verify)

Review base: `main` `05c7c6498ba24e5a6c882562f9e0c2d61c81e629`, 2026-10-11.

**Evidence level: SOURCE REVIEW ONLY.** No runtime value, secret, service setting, bucket or database was inspected or changed. Nothing was restored, deployed or contacted. **E02 = PARTIAL** (source only), **E03 = NOT RUN**.

## 1. Threat model (cross-environment)

| Asset | Threat | Source-level control | Residual risk (needs runtime attestation) |
|---|---|---|---|
| Production SQLite | Staging reads, writes or mounts it | Staging API has its own disk `noctella-staging-data` (`render.yaml:26-27`) with `DATABASE_URL=/var/data/noctella.sqlite` (`:38`). Production is **not** defined in this Blueprint. | Dashboard drift, e.g. a disk re-attached or `DATABASE_URL` overridden. The same in-volume path is fine; the invariant is the **service and disk identity**. |
| Database backup bucket (R2/S3) | Staging writes into production's backup namespace; an operator restores a staging artifact into production | Endpoint, bucket and credentials are `sync: false` (`render.yaml:136-149`). The code has **no list or delete** (Put/Head/Get only; `docs/deployment/database-backup-recovery.md:35`). | **F2:** the committed staging prefix equals the code default `database-backups` (`render.yaml:146`, `s3Compatible.ts:27`), and object keys carry no environment marker (`useCases.ts:39`). If staging were given the production bucket, staging artifacts would be indistinguishable from production ones. |
| Product-photo backup bucket | Same as above | Same `sync: false` pattern; Put/Head/Get only | **F2b:** same default prefix `product-photo-backups` (`render.yaml:163`, `product-photo-backup/s3Compatible.ts:26`). |
| Backup and scheduler crons | A staging cron triggers a production backup or job | Every cron's `API_HOSTPORT` and `SCHEDULER_AUTH_TOKEN` come from `fromService: noctella-staging-api` (`render.yaml:232-310`). The token is generated per service (`:93`). The crons only POST over the private network to `http://${API_HOSTPORT}` (`runDatabaseBackup.ts:10`, `runProductPhotoBackup.ts:10`), and the **target API's own environment** chooses the bucket. | **F3:** a manual dashboard override of `API_HOSTPORT` or the token could redirect a cron. Render's private network spans a workspace and region, so reachability depends on the account layout. Source cannot prove the runtime binding. |
| Environment configuration | Operator copies production values into staging | Origins and API base URLs are `*.staging.noctella.com` (enforced by the new test). Secrets are not committed. | **F4:** `NODE_ENV=production` on staging (`render.yaml:34,183,210`) and there is no explicit environment marker, so logs and backups cannot self-identify their environment. |
| Logs | Secrets or bucket names in logs | The backup and verify CLIs print status, object key, size and SHA only. Config errors are fixed and contain no values (existing tests). | Operator screenshots must not include environment pages. |
| Restore-verify | Changes the live DB, runs migrations, writes R2 | See §3: read-only Head/Get into an OS temp directory, read-only SQLite open, no `db/client` import. | **F5:** `verify` does not enforce the configured prefix (`useCases.ts:85` vs `:138`), so with production-readable credentials it could copy a production DB onto a staging host (data exposure, not mutation). |
| Write permissions | Staging credentials can write or overwrite production objects | The application never lists or deletes. Keys are timestamped and hashed. | Bucket credential scope cannot be checked from source. Staging keys should be write-limited to the staging bucket. |

## 2. Findings

| ID | Severity | Finding | Location | Disposition |
|---|---|---|---|---|
| F1 | Low (doc) | The checklist said "Never point staging at `/var/data/noctella.sqlite`", which contradicts the Blueprint and misstates the invariant | `ADS-009-staging-acceptance-checklist.md` §0 | **Fixed in this PR.** The invariant is now service/disk identity, with a strict prohibition on production resources. Ledger E02 wording aligned. |
| F2 / F2b | Medium (config, conditional) | The staging backup prefixes equal the code defaults, and keys carry no environment marker. Shared-bucket misconfiguration would mix environments. | `render.yaml:146,163`; `s3Compatible.ts:27`; `product-photo-backup/s3Compatible.ts:26`; `useCases.ts:39` | **Not changed** (runtime config change, owner decision). Recommendation: separate buckets per environment (preferred), plus an explicit staging prefix (e.g. `staging/database-backups`) and staging-scoped credentials. Attest per §4. |
| F3 | Medium (unverifiable at source) | Cron targets are bound to staging in the Blueprint, but dashboard overrides could re-point them | `render.yaml:232-310` | Source invariant locked by test. Runtime attestation per §4. |
| F4 | Low | No explicit environment identity at runtime (`NODE_ENV=production` everywhere) | `render.yaml:34,183,210` | Recommendation only, e.g. a non-secret `NOCTELLA_ENVIRONMENT=staging` surfaced in logs and backup metadata (owner decision). |
| F5 | Low (defense in depth) | `db:restore-verify` accepts any `.sqlite` key the credentials can read; `materialize` enforces the prefix | `useCases.ts:85`; `databaseBackup.ts:21-24` | Not changed (code change out of scope). Mitigated by credential scoping. Recommend enforcing `expectedPrefix` in `verify` as a follow-up. |

## 3. `db:restore-verify` safety (source plus new tests)

- **Entry point:** `scripts/verifyDatabaseRestore.ts` → `verifyRemoteDatabaseBackup` (`services/databaseBackup.ts:21`) → `createDatabaseRestoreVerificationUseCase`.
- **Remote operations:** Head and Get only; the verification path never calls `upload`.
- **Local writes:** only a fresh `os.tmpdir()/noctella-db-restore-verification-*` directory, removed afterwards.
- **SQLite:** the downloaded copy is opened `readonly: true` for `PRAGMA integrity_check` (`checkSqliteIntegrity`). The live `DATABASE_URL` is never opened, and nothing imports `db/client`, so `ensureSchema`/migrations cannot run.
- **New tests:** `stagingIsolationBlueprint.test.ts` proves no upload, temp-only download, temp removal and the live file unchanged (bytes and mtime). A module-graph test fails if `db/client` is imported; I checked that it detects a module that does import it.
- `db:restore-materialize` is the only command that writes a local file. It refuses the live path, existing files and keys outside the prefix (existing tests).

## 4. Sanitized runtime isolation attestation (operator; NOT executed)

Record **only yes/no answers, IDs or one-way digests** in GitHub. Never record secrets, bucket names, hostnames with credentials or environment pages.

1. **Services:** staging API, Admin, storefront and all four cron service IDs (`srv-…`/`crn-…`) are listed, and none appears in the production service list. *Yes/No*
2. **Disk:** the staging API disk ID equals the staging disk (`dsk-d9lnbgf10e5c73e1qp1g` per #335) and ≠ the production disk ID. No other service mounts it. *Yes/No*
3. **Runtime `DATABASE_URL`:** resolves inside the staging disk mount (`/var/data/…`) on the staging API service. *Yes/No* (a same-named path is fine)
4. **Backup destination:** compute `sha256(endpoint + "|" + bucket + "|" + prefix)` locally for staging and production and paste **only the first 12 hex characters** of each. They must differ. Also confirm the staging credential cannot list or read the production bucket (expect access denied). *Yes/No*
5. **Photo backup destination:** same digest comparison for `PRODUCT_PHOTO_BACKUP_S3_*`. *Yes/No*
6. **Photo storage:** `PRODUCT_PHOTO_DIR` and `MEDIA_ASSET_DIR` are under the staging disk. *Yes/No*
7. **Scheduler targets:** each staging cron's `API_HOSTPORT` is still Blueprint-managed (`fromService: noctella-staging-api`, no dashboard override), and its token is the staging-generated one (digest prefix differs from production's). *Yes/No*
8. **Origins:** `ADMIN_APP_ORIGIN`, `STOREFRONT_APP_ORIGIN`, `COOKIE_DOMAIN`, `NEXT_PUBLIC_API_BASE_URL` and `PUBLIC_API_ORIGIN` are all `*.staging.noctella.com`. *Yes/No*
9. **Attestor:** name, UTC time and the Render deploy ID observed.

Any **No** keeps E02 BLOCKED.

## 5. Staging-only restore rehearsal: prerequisites (do NOT run without separate authorization)

1. §4 is fully **Yes**, recorded in the ledger (E02).
2. Explicit, scoped owner authorization naming the staging service, the object key and the rehearsal window.
3. Run on a **staging shell or an isolated workstation**, never a production host. Use staging-only, read-only credentials where possible.
4. `npm run db:restore-verify -w apps/api -- <staging object key>` must print `integrity: ok` and a SHA matching the backup record.
5. If you materialize, the destination must be a **new** path outside the live mount (e.g. `/tmp/rehearsal-<date>.sqlite`). Never `DATABASE_URL`, never the production disk.
6. Inspect the copy read-only. Delete it afterwards and record the deletion. Do not swap it into service.
7. Record in E03 only: object key prefix, SHA-256, byte size, timestamps and result. No credentials.
