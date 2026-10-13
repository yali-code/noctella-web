# Etsy Phase 2 — Safe Media Implementation Plan

Date: 2026-10-13  
Status: planning only; no runtime, storage, provider, or infrastructure changes  
Base: `main` at `7df99bad74c822e13a690f7a3593637794b7b7c8`

## Scope and dependencies

- This plan supplements the read-only audit in Draft PR #369 and deliberately does not touch the Etsy Phase 1 implementation in Draft PR #371 (which supersedes #370 for CI). Do not merge this plan as evidence of Phase 1 acceptance.
- Existing canonical ProductPhoto records, order, primary selection, alt text, photo URLs, SKU and stock remain authoritative.
- Implement Phase 2 in separate, scoped Draft PRs *after* validating the integrated Phase 1 interfaces. Keep all Etsy provider writes, Etsy Ads changes, publishing and production deployments disabled.
- No Render plan, storage bucket, environment variable, database or production disk changes in this planning PR.

## Evidence verified from current main

1. `apps/api/src/routes/products.ts` accepts a single `photo` via `multer.memoryStorage()` with a 10 MiB per-file cap, then calls `uploadProductPhoto`.
2. `apps/api/src/services/photoStorage.ts` uses Sharp on a **Buffer**, rotates the image and creates 2000px main and 400px thumbnails as WebP. Main/thumbnail output Buffers exist during processing. `LocalPhotoStorage` writes both into `PRODUCT_PHOTO_DIR` or `uploads/product-photos`; URL base is `/images/product-photos`.
3. That same `processProductPhoto` function is used by `writeDeterministicProductPhoto` for AI-intake finalization. Any refactor must preserve deterministic key/idempotent-write semantics.
4. `apps/api/src/services/productPhotoStorageWorkflow.ts` handles promotion, retry, cleanup and legacy thumbnail-key recovery. Same-directory promotion explicitly must not delete the live file.
5. `apps/admin/src/app/products/[id]/photos/page.tsx` uploads selected files sequentially, with primary/order/delete/alt workflows.
6. Separate S3-compatible photo **backup** already exists. It must not silently be reused or relabeled as primary object storage.

The upload file-size limit does not bound decoded pixel memory, Sharp native memory or total process RSS. Historical OOM is *not* proven to originate from this route.

## Phase 2B — Bounded-memory candidate (first engineering implementation)

### Measurement first

- Add a disposable, offline benchmark with synthetic images representing small/typical/maximum byte sizes, extreme dimensions/decompression ratios, portrait/landscape, JPEG/PNG/WebP and malformed data. Do not use user photos or production credentials.
- Measure process RSS, heap used, external memory, latency, successful/failed uploads, temp-file leftovers and concurrent request count. Record test machine RAM, Sharp version, Node version and exact fixtures.
- Exercise 1, 2 and 4 concurrent uploads and 10+ *sequential* uploads; never run load tests against production/staging without explicit approval.
- Run existing upload, AI intake, outbox, delete, lock, backup/recovery and marketplace-photo regression suites before and after changes.

### Candidate design; requires benchmark acceptance

- Prefer a scoped disk-backed multipart staging path (or streamed equivalent) on a dedicated quota-controlled temporary directory instead of retaining the full upload Buffer in multer memory. Verify route permission and upload-size semantics are unchanged.
- Move photo processing behind an interface accepting staged input *without* blindly calling `readFile()` into a Buffer. Preserve the existing Buffer entry point for AI-intake until refactor regression tests prove parity.
- Bound concurrent transforms with explicit queue/backpressure and reject oversized pixel dimensions via Sharp input controls; choose limits from measured fixtures rather than untested guesses.
- Write generated main and thumbnail to uniquely named temporary targets; atomically finalize and clean partial files on every error. Maintain deterministic existing-key conflict protection and do not overwrite or delete successful photos.
- Keep DB/photo ordering, primary flag, retry/outbox and rollback behavior unchanged. Handle aborted requests, malformed multipart bodies, disk-full, decode error, interrupted writes, duplicate attempts and storage failures explicitly.
- Provide a feature-flagged rollback path to the current local processing behavior only if it preserves security and operational controls; never switch production behavior in this planning phase.

**Exit criterion:** A standalone Draft PR with before/after RSS and latency evidence, no unexpected file leftovers, passing photo/AI-intake/stock/publishing regressions, and confirmed preservation of the 10 MiB upload rejection behavior. Do not assert a target RAM number until baseline exists.

## Phase 2A/2C — ERP-to-Etsy photo parity

- Reuse canonical ProductPhoto IDs; default Etsy selection/order to ERP primary and sortOrder. Use an explicit per-channel override only if proven necessary; never silently reorder eBay or Noctella Web photos.
- Confirm current Etsy Open API v3 constraints (images, video, ordering, thumbnail/crop, limits, media endpoints, OAuth scopes). Seller UI behavior alone is not an API contract.
- Define media readiness from a canonical ready photo snapshot; provider IDs, partial-upload reconciliation, retries and idempotency belong to a *later* Etsy integration PR.
- A separate schema/interface design review is required before any Etsy-specific media mapping or migration.

## Phase 2D — Primary object storage decision gate

Evaluate primary S3-compatible object storage as a distinct system from existing backup storage:

1. Object keys, immutable versioning or content hashes, per-product paths and metadata/ordering ownership.
2. Durability, private access, signed serving/CDN URLs, cache invalidation, egress/storage request costs, 500 products/10,000 photos model and provider outages.
3. Dual-read/fallback before write cutover; independently verify data copies and SHA-256 against manifests. Never delete existing local originals or backup artifacts during initial migration.
4. Backfill, resumable retry, idempotent write, partial failure/rollback and complete recovery drills.
5. Explicit owner approval before credentials, buckets, storage plans, migration runs or production cutover.

## Proposed acceptance matrix

| Area | Required evidence |
|---|---|
| Upload contract | JPEG/PNG/WebP, max 10 MiB, missing/malformed input and auth rejected |
| Resource safety | Peak RSS/heap/external memory recorded; safe 1/2/4 concurrency and 10+ sequential |
| File lifecycle | No orphan temp files after abort/failure; existing originals never deleted on retry |
| Image parity | WebP main ≤2000px, thumbnail ≤400px, orientation, metadata, URLs and alt text preserved |
| Data integrity | Canonical IDs/order/primary/stock, outbox promotion and rollback retained |
| AI intake | Deterministic finalization retry and collision behavior unchanged |
| Existing channels | eBay and Noctella Web photo readiness/publishing tests green |
| Object storage | Recovery verified; backup remains separate; no cutover without explicit approval |

## PR sequence

- **P2-0 (this PR):** documentation and safety plan, no runtime behavior.
- **P2-1:** offline benchmark and repeatable fixtures only, separate Draft PR.
- **P2-2:** bounded-memory upload implementation based on P2-1 evidence, separate Draft PR.
- **P2-3:** Etsy media read-only selection preview, after Phase 1 integration, separate Draft PR.
- **P2-4:** primary object storage design/cost/recovery proof, separate Draft PR.
- **P2-5:** owner-approved staged migration and capacity verification, not authorized now.

Owner review needed independently for any merge/deploy, real provider write, and infrastructure change.
