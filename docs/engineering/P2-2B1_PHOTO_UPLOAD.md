# P2-2B1: gated disk-backed product upload candidate

Relates to #384 and #377. Design: #381. Benchmark fixtures: #379 at 7c6ab55237e996fef041c60bb06f45b7d0fc2061. Linux observer adapted from #383 at 44ae46b; final CI #532 passed. No reference PR is modified or merged.

## Review scope and activation gate

This independently reviewable slice implements the real product-photo route behind PRODUCT_PHOTO_DISK_STAGING_ENABLED=true. Default remains the legacy route. Do not enable in production based on this PR. AI-intake uploads/finalization and Instagram Sharp callers are not admitted by this controller; therefore this is **not yet a process-wide image memory bound**. Product uploads share a process singleton. No storage, database schema, credentials or marketplace provider configuration changes.

The Buffer PhotoStorage and deterministic AI interfaces remain intact. A common image recipe retains rotate, inside/no enlargement, main 2000px WebP86, thumbnail 400px WebP82. Original encoded size remains sizeBytes. IDs, random storage keys, public URLs, row locking, ordering/primary selection, alt text, promotion outbox payload/transaction and backup boundaries stay unchanged. eBay/Etsy/Web consume the same persisted URLs/metadata. One integrity correction also applies to the legacy service: compensation deletes newly owned files only when its DB transaction fails, never after a committed transaction followed by a failed response read.

## Resource model

| Resource | Candidate limit | Qualification |
| --- | --- | --- |
| Encoded input | 10 MiB inclusive | Multer sentinel is max+1, followed by own exact bound |
| Raw multipart body | 10 MiB + 72 KiB | Streaming counter, no concatenation |
| Multipart | one photo, optional one altText <=8192 bytes | Unknown/nested fields rejected; parts sentinel accommodates Busboy equal-bound behavior |
| Image | 24,000,000 pixels; 12,000px each edge | Sharp input-pixel limit plus metadata checks before derivative decode; provisional, not representative-customer validation |
| Active / waiting | one / two | Reservation before DB/body/directory; FIFO after receive; 5s queue wait |
| Receive | 30s | Abort staging streams, settle writes before deletion |
| Transform alarm | 60s | Closes new admission; cannot cancel native work safely; holds permit until physical settlement |
| Private disk | 42 MiB per admitted request; 128 MiB aggregate software reservation | 10 MiB input + two post-encode checked 16 MiB outputs; three reservations =126 MiB |
| Linux hard memory / target | 512 / 384 MiB | Neither threshold may be raised to get green measurements |

Disk staging lives in a private 0700 sibling of the canonical root; files use exclusive 0600 creation. Client names never become paths. Reject symlink roots/files, public/intake overlaps and nonregular inventory. Sharp reads paths and derivatives use native file output and are size-checked before publication, without whole-input readFile or derivative toBuffer. Main and thumb publish with no-overwrite hardlinks; only newly owned files are compensated on failure. EXDEV fails closed (same-volume staging required). Root remains trusted operator configuration; do not let untrusted local actors write parent directories.

Output limits are checked after native encoding; a pathological output can exceed its reservation transiently before rejection/cleanup. Sharp 0.34.5 stream output creates a full encoded JS Buffer (installed lib/output.js and src/pipeline.cc); toFile uses the file encoder instead. See https://sharp.pixelplumbing.com/api-output/#tofile. Native codec working memory still exists. This reservation is not a filesystem quota and does not cover other processes, SQLite, intake or unrelated disk usage. Crash orphans are scanned and counted, never age-deleted blindly; unsafe inventory or exhaustion closes admission until operator recovery. Native/temp-library overhead needs Linux observation. Existing canonical bytes are never reclaimed by this request cleanup.

## Failure behavior

Invalid image/pixel limit: 400 JSON; malformed/oversize multipart: 400/413 JSON; slow receive:408; capacity/queue/storage:503 JSON with Retry-After:1. Success remains201 ProductPhoto. These replace legacy unhandled Multer500 HTML errors on the gated path. Clients must not blindly retry an ambiguous post-commit failure.

Abort cancels queued/receiving work. Active native transforms settle before lease release or work-directory deletion. Storage/cleanup failure closes future admission. If DB persistence completed, a staging-cleanup failure retains201 and saved canonical files, records a safe warning and closes admission. SIGTERM/SIGINT close the gate before existing graceful shutdown. Existing shutdown deadline can still kill native work: restart inventory protects against silently exceeding the reservation.

Crash between publication and DB commit can leave unreferenced canonical files. B1 deliberately does not delete these by age; DB/outbox-aware reconciliation remains follow-up. Crash after one link never corrupts an existing key. File cache is disabled in libvips on first candidate processing to allow Windows cleanup; this is process-wide cache policy and can affect other Sharp callers' performance, not their recipes. Default-off import does not change Sharp cache.

## Tests and acceptance

New contracts capture legacy orientation/WebP/deterministic retry bytes and post-commit compensation. Controller/transport/storage tests cover FIFO, queue timeout, fourth admission, cancellation without early native release, alarm fail-closed, exact 10-MiB boundary, oversized/extra fields/files, auth-before-staging, disk-full, orphan inventory, cleanup failure, interrupted multipart, receive timeout, JPEG/PNG/WebP alpha, dimensions/pixels, invalid input and no-overwrite publication failure. Real-app authenticated tests assert metadata/order/primary/alt, recipe byte parity and promotion outbox.

Regression suites include existing photos, outbox workflow/restart/stale-lock/scheduler, backup/recovery and deterministic AI-intake services/routes/restart. CI runs all repository tests, typechecks, builds, lint and real disposable PostgreSQL tests. See PR for executed totals and actual CI status.

The dedicated photo-upload-linux workflow is explicit workflow_dispatch or same-repository PR title edit starting [run-upload-512m]. Normal PRs only run nine fast policy tests. It builds a source-only disposable context, generates pinned synthetic fixtures, then fresh 512-MiB/no-swap/network-none/read-only-root one-CPU containers per case. It checks limits inside and outside, retains a keepalive observer on worker OOM, samples RSS/cgroup/disk, captures exact peak/events/exits and always uploads evidence. Twelve bounded smoke cases cover near-limit JPEG/PNG/WebP at client concurrency1/2/4, sequential12, invalid input and four144-MP rejects. Only fixture generation gets2GiB; generation is outside measurements.

The worker imports the actual app, seeds isolated SQLite/auth/category/product, streams loopback multipart via files and checks DB/outbox/output counts. No index schedulers, customer photos, production keys, provider calls or network access. The streaming client is in-process and shares the measured cgroup; full API startup and auth are included in peak, while a separately reported warm baseline follows setup. Runs are one trial per case, not production or full acceptance. c4 overload is expected only with PHOTO_CAPACITY_BUSY; normal cases must have successes and c1/c2 may not overload. Queue timeouts fail evidence. Exceeding384MiB or any max/OOM counter fails, even with valid outputs.

## Remaining P2-2B sequence and approval gates

1. Integrate all Sharp entry points with shared admission without deadlocking deterministic AI finalization; retain existing retry/conflict contracts. Evaluate Sharp concurrency1 explicitly with cache/thread observations.
2. Validate24MP/12000 against representative synthetic orientations/animated/corrupt/truncated formats; obtain owner approval of actual customer-facing limits without using customer media here.
3. Add real temporary-filesystem quota/free-space guard, maximum staging age ownership protocol, startup safe recovery and canonical DB-aware orphan reconciliation; inject output ENOSPC and hard-kill/restart faults.
4. Repeat Linux real-API multipart measurements at1/2/4 at least three times,30-minute soak, slow/adversarial clients,24MP photos, AI-intake combined load, dispatcher/backup overlap and near-disk-full. Include external streaming client, Linux API baseline, heap/external/native/cgroup peaks and page cache. Keep384MiB.
5. Compare two transforms only as an isolated candidate; no rollout without evidence under512MiB. Confirm admin actionable overload UX and provider payload regression snapshots.
6. Review resource results and operational recovery before separate enablement approval. No production-readiness claim from B1 smoke.

## Rollback

Leave/unset the gate to use the existing route. No migrations or key transformations to reverse. Already committed photos/outbox remain valid on either route. Before rolling back an enabled instance, drain requests, preserve staging inventory, reconcile against DB/outbox and handle only proven-owned orphans. A code revert removes the candidate without deleting canonical media. Disabling the gate alone does not bound legacy memory, and does not justify higher concurrency.

## Interface and Sharp entry-point inventory

| Location | Contract retained / B1 status |
| --- | --- |
| routes/products.ts POST /:id/photos | auth/products.edit before ingress; single photo + optional altText;201 ProductPhoto |
| services/photoStorage.ts PhotoStorage.saveProductPhoto/deleteProductPhoto | Buffer API retained for legacy callers; random main/thumb WebP keys and original size metadata |
| services/photoStorage.ts writeDeterministicProductPhoto | canonical IDs/keys and exact-content retry/conflict remain; no new admission wrapper |
| services/aiIntakePhotoStorage.ts saveIntakePhoto | Buffer ingress, rotate + WebP86 file output remains unmodified; not admitted |
| routes/aiProductIntakes.ts + services/aiIntakePhotoFinalization.ts | Multer memory ingress and LocalAiIntakePhotoReader Buffer finalization remain; not admitted; source retention and manifest preparation stay outside transaction |
| integrations/instagram/mediaPreparation.ts | metadata/raw decode validation and40MP preparation remain unmodified; not admitted |
| services/products.ts + photo mutation lock capability | shared persistence transaction, primary/order/photo row + promotion outbox; no post-commit file compensation |
| services/productPhotoOutboxDispatcher.ts and backup/recovery repositories | existing keys, Ready checks, same-root promotion ownership, checksum/size/key checks and remote read/write interfaces untouched |
| apps/admin/src/app/products/[id]/photos/page.tsx | sequential awaited uploads, per-file status, successful uploads never automatically retried; no UI edits |
| Publishing consumers | same photo IDs, URLs, primary/order and alt fields; no provider calls or provider adapters changed |

Rejected requests reserve no transform/disk work. To reliably deliver an early response for a valid near-limit body, a bounded raw discard (at most body budget or1000ms) precedes Connection:close; chunks are never parsed/concatenated/stored. This adds a finite error-path delay and transport work. Extreme/slow oversized senders can still observe connection closure rather than a complete JSON response; overload drain and overall HTTP connection limits need adversarial acceptance before enabling.

## Evidence ledger (intermediate, not final acceptance)

- Intermediate stream-output revision5d37f87: Actions38425661511; artifact11828019581; ZIP SHA256 5c9b13f982d70b995ee8fa7ad4d1edd8b10450b8bce569dbdbcb4486a0a3f2fe. All cases correctly failed: loader cache cleanup and early overload TCP resets. Raw summary preserved as intermediate-5d37f87-summary.json. This revision was superseded by native file output.
- Native file-output revision75fb3de: Actions38426951715; artifact11829296963; ZIP SHA256 6da4936d41c024a3e8037ee22e99984a54de24508011d9ce2cf9a5c0cfb6e08f. Eight cases passed, four c4 cases failed with client ECONNRESET/exit2. No max/OOM events. Raw summary native-75fb3de-summary.json includes failures; do not present the run as green.
- Successful native cases' peak cgroup MiB: JPEG c1 226.69/c2 235.37; PNG c1 260.11/c2 257.85; WebP c1 289.25/c2 287.45; mixed sequential12 337.03; invalid122.61. Corresponding process RSS/HWM differs and must not replace cgroup accounting.
- The c4 retry profile selects exactly four failed cases after bounded rejection-discard correction; it never silently skips failures from a full run. The combined evidence spans explicit revisions; it is not a full final-head12-case rerun, three trials, soak or production acceptance.
- Temporary disk observer counts all disposable /work bytes (including SQLite and canonical outputs); transient hardlinks may be double-counted. It is conservative logical/allocated high-water, not exclusively private staging usage. Heap/external/ArrayBuffer samples begin at warm baseline; OS process high-water and cgroup peak also cover startup.

## Regression and follow-on acceptance matrix

| Failure/contract | Evidence in B1 | Required before enablement |
| --- | --- | --- |
| Real auth, role denial,201 metadata/primary/order/alt/outbox | productPhotoStagedRoute; existing productPhotos/outbox suites | provider payload/UI review on accepted limits |
| EXIF/main/thumb byte parity and deterministic retries/conflict | photoUploadContractsP22B1; real staged-route byte comparison; existing deterministic finalize/restart suites | all shared entry points under the same admission |
| Admission1+2, FIFO, queue timeout, alarm, queued abort/no early native release | productPhotoBoundedUpload | multi-route/worker stress and orderly shutdown drain |
| Exact10MiB/+1, malformed/extra parts, fields and raw limits | productPhotoBoundedUpload | slow/adversarial HTTP connections and rejected-body load |
| Input and output ENOSPC, publication collision/EXDEV, oversize output | injected deterministic tests | real Linux quota/disk-full, partial publish and restart |
| Partial upload/client abort/receive timeout | real local HTTP tests | hard-kill active native encode and ownership recovery |
| Invalid/truncated images, alpha,24MP and over-limit/edge | storage tests and Linux invalid/144MP rejection cases | additional format/animation/representative pixel-boundary corpus |
| Private cleanup fail, inventory orphans/no blind deletion | deterministic fault tests | crash sweep protocol, DB-aware canonical reconciliation |
| Post-commit response failure must keep referenced pair | regression red on original code, green after compensation boundary fix | PostgreSQL commit-ambiguity/retry analysis |
|512MiB/no swap, target384, cgroup/RSS/disk/exits | measured versioned Linux HTTP smoke evidence | final-head full12 cases, three trials +30min soak and combined AI/outbox/backup load |


Candidate transaction errors retain published files because a lost commit acknowledgement cannot prove rollback. They return503 PHOTO_STORAGE_UNAVAILABLE and close admission for operator recovery, even if the transaction actually rolled back. This can retain one unreferenced pair per failure/restart; do not automatically retry or delete it. A committed-then-throw regression proves the row survives without a destructive compensation attempt. Legacy rollback compensation remains unchanged; its network commit-ambiguity analysis is follow-on. Post-commit response-read failures preserve files on both paths.

c4 retry ae41eea / Actions38428694945 / artifact11829967653 (SHA256 e0b849dc33711c9c441a28c5e7e3b78ed269e4c712a45e80c301363adc89ee6d): JPEG233.55MiB, PNG239.15MiB and144MP rejection137.60MiB passed. WebP failed with write EPIPE; three admitted requests still returned201, but the early503 transport was not reliable under the250ms discard deadline. The deadline is now bounded at1s and the remaining WebP case was retried successfully (see final report). Raw summary c4-ae41eea-summary.json preserves the failure. Memory target and cgroup limits are unchanged.

Final targeted WebP c4 on fa3adb6 passed in Actions38430085616:290.84MiB cgroup peak,321.75MiB process RSS/HWM,3x201 and1x503 PHOTO_CAPACITY_BUSY, zero max/OOM counters, exit0 and clean temporary state. The twelve selected versioned successes (not a full final-head rerun) and all earlier failures are in [the resource report](photo-upload-evidence/REPORT.md). No three-trial/soak/combined-load acceptance is claimed.
