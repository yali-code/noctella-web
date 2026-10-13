# Noctella Phase 2 — Primary Media Storage and Bounded-Disk Recovery Decision Record

Date: 2026-10-13  
Status: Proposal / read-only code review; no runtime implementation, provisioning or production approval  
Tracking: #374. Parallel to Claude Code's P2-1 benchmark (#373). Supplements Draft planning PR #372 and audit PR #369.  
Baseline: main `7df99bad74c822e13a690f7a3593637794b7b7c8`.

## Grounded code facts

- `apps/api/src/services/photoStorage.ts`: local primary `PRODUCT_PHOTO_DIR`; image inputs represented as Buffers; Sharp produces a max-2000px WebP main and max-400px WebP thumbnail. AI intake deterministic photo finalization shares this processor and protects existing keys from overwrite.
- `apps/api/src/services/productPhotoStorageWorkflow.ts`: photo promotion, retry, cleanup and legacy thumbnail recovery use local keys and directory containment checks. Same-root promotion explicitly cannot delete already-live files.
- `apps/api/src/services/productPhotoBackup.ts`: S3-compatible **backup** separately scans local photo references and local files; not a live/primary media store.
- `apps/api/src/repositories/product-photo-backup/s3Compatible.ts`: remote metadata includes SHA-256 and size; PutObject streams from local files; GetObject streams to a local file with a declared byte cap.
- `apps/api/src/use-cases/product-photo-backup/useCases.ts`: SHA-256 content-addressed backup objects and manifest; verification downloads and rehashes each object.
- `apps/api/src/repositories/product-photo-backup/types.ts`: individual backup artifacts capped at 16 MiB; manifest also capped at 16 MiB.

### Distinct audit concern: recovery verification temporary disk

`createProductPhotoRecoveryVerificationUseCase` downloads each manifest entry to a distinct `artifact-${index}.webp` inside one temporary directory. That directory is removed only in the enclosing `finally` after all entries have been verified. Thus maximum temporary disk demand grows roughly with **the sum of all verified artifacts**, not with the largest one. For a 10,000-photo catalog with both main and thumbnail, this may exceed the disk available to a small instance. This is a **design risk inferred from source**, not evidence of a production incident.

Proposed independent bounded-disk mitigation (future dedicated Draft PR; not implemented here):
- Verify one artifact at a time, remove its verified local temp file in a per-artifact `finally`, then proceed. Retain manifest and at most one artifact simultaneously.
- Preserve size and SHA-256 checks, explicit `wx` file creation and cleanup on failure.
- Test a manifest with many entries and a fake repository asserting prior artifact files have been removed before the next download; test missing object, partial download, digest mismatch, cleanup exception and repeat verification.
- Do not change the deployed backup worker or actual backup storage until separately approved.

## Primary object storage architecture — proposed, not yet selected

1. **Canonical metadata:** database retains ProductPhoto ID, product ID, primary flag, sort order, alt text, image dimensions, processing status and stable logical storage references. Provider URLs are not authoritative for photo identity.
2. **Object keys:** unique, server-derived, collision-resistant names; immutable/verified hashes where feasible. Never derive trusted object keys directly from raw user filenames. Main and thumbnail must be accounted for separately.
3. **Data plane:** put new assets into a distinct *primary* namespace/bucket with separate access policy from existing immutable backup artifacts. Avoid public write and broad list permissions; use signed reads/CDN when appropriate, with predictable cache behavior.
4. **Transactional boundary:** stage and validate object writes, persist DB metadata atomically relative to internal outbox events, reconcile remote object existence on retry, and only then mark photo ready. Since database and object store do not share one transaction, design idempotent operations with compensating cleanup of unattached staged objects.
5. **Serving path:** keep old product photo references resolvable through compatibility logic. Prefer dual-read (primary object, verified fallback to legacy local) during migration; avoid silently changing existing URL semantics. Verify media authorization and cache invalidation for any private assets.
6. **Migration:** enumerate manifest of canonical references, copy originals + thumbnails, verify individual size/hash, record per-artifact state, exercise rollback, then enable dual-read; only after a complete reconciliation and approved cutover enable primary writes. Never delete local originals or backup data in initial steps.
7. **Disaster recovery:** restore both object bytes and database mappings, including photo order and primary flag. Validate a recovery into an isolated disposable environment; integrity alone is not a complete service-level restore test.
8. **Operations:** define alerting for failed writes, pending outbox, missing objects, rising retry counts, backup age and failed restores. Separate write and read-only identities. No credentials in repository or reports.
9. **Provider:** compare at least two S3-compatible options for region, availability, egress, API operations, bucket policies, lifecycle/retention and restore times. Pricing must be verified at procurement time; none is assumed in this ADR.

## Capacity and cost worksheet (assumptions, not measured predictions)

For 10,000 **canonical photos**, assume each has one main + one thumbnail: roughly **20,000 artifacts**, before versions, duplicate uploads or separate marketplace media.

For illustration only:

| Illustrative average main / thumbnail | Primary storage for 10,000 pairs | Notes |
|---|---:|---|
| 0.5 MB / 0.05 MB | 5.5 GB | Decimal GB, without versions/overhead |
| 1.0 MB / 0.10 MB | 11.0 GB | Decimal GB, without versions/overhead |
| 2.0 MB / 0.20 MB | 22.0 GB | Decimal GB, without versions/overhead |

These sizes are *scenarios*, not measurements. The 1 GB current persistent disk is not an appropriate assumption for a complete 10,000-photo primary store.

Cost model per month:

`cost ≈ stored_GB × price_per_GB_month + outbound_GB × egress_price_per_GB + PUT_count × write_price + GET_count × read_price + CDN/other fees + retention/version overhead`.

Budget for a *separate backup copy*, restore transfer, temporary staging, and provider/API call charges. Do not double-count photo count vs artifact count.

## Decision gates

**Gate A — Measurement (Claude P2-1):** synthetic image distributions, RSS/heap/external peaks and disk behavior under sequential + 1/2/4 concurrent uploads. Do not decide 512 MiB RAM adequacy from synthetic benchmarks alone.

**Gate B — Bounded recovery (separate P2-4a Draft PR):** cap verification staging to manifest + at most one local artifact; test all fail/cleanup scenarios without touching remote provider or production.

**Gate C — Provider selection:** get verified price/egress/requests/region quotations; document access controls, retention/backup independence and risks. Owner chooses vendor and approves infrastructure spend.

**Gate D — Migration design acceptance:** dual-read and rollback proof; no missing or reordered ProductPhoto references; verified checksums and artifact counts. Backup recovery remains independently tested.

**Gate E — Execution approval:** separate, explicit owner authorization for any bucket/environment variable/Render plan changes, staging migration, production cutover or deletion.

## Open questions requiring measured evidence

- Actual mean/p95/p99 main+thumbnail bytes for canonical inventory, excluding personally identifying data.
- Available temporary disk during recovery, maximum manifest artifact count, and restore time on the selected instance.
- Existing DB provider and its backup/recovery RPO/RTO, which must accompany photo bytes for a complete catalog restore.
- CDN/cache, cross-region transfer and egress charges under expected Instagram/eBay/Etsy storefront traffic.
- Whether future provider-specific media selections require a separate mapping table; no implementation before Etsy API v3 capability validation.

## Scope isolation

This document makes no changes to `apps/api/src/services/photoStorage.ts`, multipart routes, photo outbox, test fixtures, migrations, CI workflows or Render services. It must not be merged or deployed without owner permission. Claude's P2-1 benchmark can proceed independently.
