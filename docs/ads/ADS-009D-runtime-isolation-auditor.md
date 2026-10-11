# ADS-009D — Runtime isolation auditor (E02), operator-run and read-only

The tool is `npm run ops:isolation-audit -w apps/api`. It is implemented in `apps/api/src/use-cases/isolation-audit/stagingIsolationAudit.ts` (pure) and `apps/api/src/scripts/auditStagingIsolation.ts` (CLI). Tests are in `apps/api/tests/stagingIsolationAudit.test.ts`.

The tool **compares** two operator-assembled snapshots, staging and production, and prints `PASS` / `FAIL` / `UNKNOWN` per check with a fixed reason code. It never reads Render, R2, the database, environment variables or files. It never calls a network or a provider. It never prints input values, hosts, paths, bucket names or digests.

## Rules that keep the verdict honest
- Only snapshots marked `"source": "effective_runtime"` can produce PASS: values read from the live service settings by an owner-access operator. A `"blueprint"` or `"unknown"` source makes every value check UNKNOWN. `render.yaml` never proves runtime state.
- **Bucket identity** (storage account host or AWS region, plus bucket) is checked separately from the **prefix**:
  - Same bucket with different prefixes = **FAIL** (I06/I08).
  - Overlapping prefixes are reported as an advisory FAIL (I07/I09). This is the F2 finding from ADS-009C.
- An identical in-volume `DATABASE_URL` is fine. It must resolve inside the **staging** disk mount (I04), and the disks must differ (I03).
- Credential scope and disk attachment cannot be proven offline. They come only from explicit operator YES/NO answers (I12–I14).
- `overall` is PASS only if every *required* check is PASS. Any required FAIL gives `e02Gate: BLOCKED`. Anything unproven gives `PARTIAL`. A PASS still needs reviewer sign-off (`PASS_PENDING_REVIEW`).

## Checks
| ID | Check | Required |
|---|---|---|
| I01 | Both snapshots come from effective runtime settings | yes |
| I02 | Service IDs are disjoint; staging API is the expected service | yes |
| I03 | Staging and production disks differ; the staging disk is the expected one and attached to the staging API | yes |
| I04 | Staging `DATABASE_URL` is absolute and inside the staging disk mount | yes |
| I05 | Staging `PRODUCT_PHOTO_DIR` and `MEDIA_ASSET_DIR` are inside the staging mount | yes |
| I06 / I08 | Database and photo backup buckets differ from production (identity, not prefix) | yes |
| I07 / I09 | Backup prefixes do not overlap production's | advisory |
| I10 | Every staging cron's `API_HOSTPORT` and scheduler token are Blueprint-bound (`fromService`) to the staging API, with no manual override | yes |
| I11 | Staging origins and cookie domain are `*.staging.noctella.com` and share nothing with production | yes |
| I12 / I13 | Operator: the staging backup credentials are **denied** on the production buckets | yes |
| I14 | Operator: the production disk is not attached to any staging service | yes |

## Operator procedure (trusted workstation; nothing committed or pasted to GitHub)
1. Assemble the JSON **in memory or a scratch file outside the repository**, following the shape below.
   - Copy values from the Render dashboard's *live* environment of each service.
   - **Never include credentials.** The schema rejects unknown fields, including any `accessKey`/`secret`, with `INPUT_SCHEMA_INVALID` and no echo.
2. Run `npm run -s ops:isolation-audit -w apps/api < snapshot.json`. Delete the scratch file afterwards. The tool accepts no arguments, which keeps values out of shell history.
3. Paste **only the tool output** (ids, statuses, reason codes) into the E02 row of the ledger, with the attestor name, UTC time and the observed Render deploy IDs.
4. Exit code: `0` PASS, `2` UNKNOWN, `1` FAIL or error.

```json
{
  "expected": { "stagingApiServiceId": "<srv-…>", "stagingDiskId": "<dsk-…>", "productionDiskId": "<dsk-…>" },
  "staging": {
    "source": "effective_runtime",
    "apiServiceId": "<srv-…>", "otherServiceIds": ["<srv-…>", "<crn-…>"],
    "diskId": "<dsk-…>", "diskAttachedToServiceId": "<srv-…>", "diskMountPath": "/var/data",
    "databaseUrl": "<live DATABASE_URL>", "productPhotoDir": "<live>", "mediaAssetDir": "<live>",
    "databaseBackup": { "endpoint": "<live>", "region": "<live>", "bucket": "<live>", "prefix": "<live>" },
    "photoBackup": { "endpoint": "<live>", "region": "<live>", "bucket": "<live>", "prefix": "<live>" },
    "origins": { "adminAppOrigin": "<live>", "storefrontAppOrigin": "<live>", "publicApiOrigin": "<live>", "nextPublicApiBaseUrl": "<live Admin value>", "cookieDomain": "<live>" }
  },
  "production": { "source": "effective_runtime", "apiServiceId": "<srv-…>", "diskId": "<dsk-…>", "databaseBackup": { "…": "…" }, "photoBackup": { "…": "…" }, "origins": { "…": "…" } },
  "stagingCrons": [{ "serviceId": "<crn-…>", "source": "effective_runtime", "apiHostportSetting": "fromService", "boundServiceId": "<srv-…>", "schedulerTokenSetting": "fromService" }],
  "operatorAttestations": {
    "stagingDatabaseBackupCredentialDeniedOnProductionBucket": "YES",
    "stagingPhotoBackupCredentialDeniedOnProductionBucket": "YES",
    "productionDiskNotAttachedToAnyStagingService": "YES"
  }
}
```

For production, supply only what the checks compare: service and disk IDs, backup endpoint/region/bucket/prefix, and origins. Production credentials are never needed.

## Minimum human-only checks (if the snapshot cannot be assembled safely)
Answer YES or NO and record only the answer:
1. Is each staging service ID absent from the production service list?
2. Is the staging API's disk ID different from production's, and attached only to the staging API?
3. Does the live staging `DATABASE_URL` point under the staging disk mount?
4. Do staging's database and photo backup settings name a **different bucket** (not just a different prefix) from production's?
5. Does a staging backup credential get **access denied** on the production buckets? Check with a read-only HEAD/list test in the provider console, never a write.
6. Does each staging cron show `API_HOSTPORT` and `SCHEDULER_AUTH_TOKEN` as Blueprint-linked to `noctella-staging-api`, with no manual value?
7. Are all staging origins and the cookie domain `*.staging.noctella.com`?

## CLI threat model
- **Output leaks:** only fixed ids, codes and titles. Tests assert there are no markers, hosts, paths, service IDs or 12+ hex digests in the output.
- **Error leaks:** every failure maps to a fixed `ISOLATION_AUDIT_ERROR: <CODE>`. Zod issues and exception messages are never printed.
- **Shell history:** argv is rejected; input comes via stdin only.
- **Accidental secrets in input:** a strict schema rejects unknown fields. Input is capped at 64 KB.
- **Side effects:** no network (tested with a `fetch` spy), no `db/client` import (tested), no file writes, no environment reads.
- **Misuse as proof:** Blueprint or unknown sources can never PASS. Operator attestations are labelled as such in reason codes.

## Status
This tool has **not** been run against real settings. E02 stays **PARTIAL** until an owner-access operator runs it with effective-runtime values (or answers the minimum checks) and the result is reviewed. E03 stays **NOT RUN**.
