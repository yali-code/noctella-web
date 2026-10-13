# P2-2A: photo upload memory safety design and validation gates

Date: 2026-10-13. Status: proposal for review; **P2-2B implementation and 512-MiB acceptance are not authorized or achieved here**.
Tracking: [#377](https://github.com/yali-code/noctella-web/issues/377).
Evidence: [Draft #379](https://github.com/yali-code/noctella-web/pull/379), head
7c6ab55237e996fef041c60bb06f45b7d0fc2061; CI #529 independently verified completed/success.
Design baseline: latest fetched origin/main, 7df99bad74c822e13a690f7a3593637794b7b7c8.
Worktree branch: docs/photo-upload-memory-safety-p2-2a. No other PR branch changed.

## Decision and evidence boundaries

Prefer private disk-backed multipart staging, path-based Sharp input, sequential main/thumbnail
output streaming, and a shared process admission controller. Begin constrained-host evaluation
with one active transform and two bounded staged waiters. Evaluate two active transforms as an
alternative; do not enable it unless the same memory/headroom gates pass.

This is implementation-ready sequencing, interfaces and acceptance criteria, **not a claim that
these budgets are safe in production**. Proposed limits alter acceptance/overload behaviour and
need owner review. No customer-media inventory was accessed. Representative real-photo
compatibility and Linux full-API baseline are missing.

P2-1 combined 30 retained baseline scenarios and five corrected PNG scenarios: 35 scenarios,
155 operations, 148 successful transforms and seven expected rejections. Original near-limit
PNG was 14.09 MiB and measured rejection; use the corrected 9.56-MiB PNG measurements below.
The raw source and scenario index remain on #379; do not copy or edit its recovered files.

| Measured P2-1 workload | In flight | Peak RSS MiB |
|---|---:|---:|
| Near-limit JPEG, 8 operations | 1 / 2 / 4 | 159.0 / 180.1 / 269.5 |
| Corrected near-limit PNG, 8 operations | 1 / 2 / 4 | 138.7 / 185.9 / 288.8 |
| Mixed, 12 operations | 1 / 2 / 4 | 196.0 / 237.4 / 256.7 |
| PNG 144 MP | 1 / 4 | 201.2 / 555.4 |
| Sequential mixed / near-limit, 12 operations | 1 | 187.2 / 144.3 |

The Windows i5-3210M / 8066-MiB host used Node 24.18.0, Sharp 0.34.5 and libvips 8.17.3.
The API CI uses Node 20; benchmark/runtime version alignment is an acceptance requirement.
These isolated child peaks omit Express, DB, other jobs, actual multipart and concurrent users.
555.4 MiB exceeds the stated target but does not establish Render's precise failure threshold
or explain any historical OOM. A 10-MiB encoded cap does not bound decoded/native memory.
Sharp concurrency=1 in P2-1 changed a four-upload JPEG peak to 248.9 MiB; disabling cache
measured 272.4 MiB. Neither is a substitute for active-job admission or a universal optimization.

## Verified contracts and compatibility map

| Boundary / source | Existing contract to preserve | Proposed internal adaptation |
|---|---|---|
| [products route](../../apps/api/src/routes/products.ts) and [app](../../apps/api/src/app.ts) | Admin requireAuth mount, products.edit permission before multipart, POST /api/products/:id/photos, single field photo, optional altText, 10*1024*1024-byte file cap; missing file 400 with error Photo file is required; success 201 ProductPhoto | Admission and private staging middleware after auth/permission; explicit cleanup/error middleware, same successful response |
| [uploadProductPhoto](../../apps/api/src/services/products.ts) | Buffer/mimetype/size input, optional injected PhotoStorage, ProductPhoto UUID, authoritative product-row lock for sortOrder=count and first-primary, shared metadata+promotion-outbox insert, no stock writes | Keep existing callable signature and mocks; add staged-input entry point and factor a single common persistence/lock orchestration rather than duplicate transaction rules |
| [PhotoStorage](../../apps/api/src/services/photoStorage.ts) | saveProductPhoto(Buffer input) -> StoredProductPhoto; deleteProductPhoto(url/thumbnailUrl); filename, URLs, image/webp, dimensions; sizeBytes currently means original input bytes | Add companion StagedPhotoStorage.saveStagedProductPhoto with server-owned path/lease/mimetype/actual size; same result; no fake Buffer or readFile fallback |
| Canonical transform in photoStorage.ts | auto-orientation via rotate; WebP main <=2000x2000 quality86, thumbnail <=400x400 quality82, inside fit, no enlargement; local root PRODUCT_PHOTO_DIR and /images/product-photos URL base | One shared transform recipe accepting Buffer or staged path. Path output may stream to unique temporary files; exact output parity is a regression gate |
| [photo outbox](../../apps/api/src/services/productPhotoStorageWorkflow.ts) and [dispatcher](../../apps/api/src/services/productPhotoOutboxDispatcher.ts) | Processing -> Ready only after both canonical files exist; same-root promotion checks only and never copies/unlinks live files; storage keys from actual URLs; legacy thumbnail recovery; retry/delete events | Keep canonical roots, keys and handlers. New multipart staging is a separate private namespace and is NOT the outbox tempRoot |
| [AI finalization](../../apps/api/src/services/aiIntakePhotoFinalization.ts) and [manifest preparation](../../apps/api/src/use-cases/ai-intake-photo-finalize/useCases.ts) | Preparation outside DB locks; sequential staged reads; productPhotoId=staged.id; productId-stagedId.webp and -thumb.webp; same bytes retry/no overwrite on different bytes; authoritative locked revalidation; already-Finalized retry skips filesystem | Preserve Buffer interface, deterministic output/conflict semantics and finalized fast path; admission must cover staged read AND transform, not acquire after the Buffer is already read |
| [AI intake staging](../../apps/api/src/services/aiIntakePhotoStorage.ts) and [intake route](../../apps/api/src/routes/aiProductIntakes.ts) | Separate private photo root, WebP without canonical resize/thumb; own permission and Buffer-based storage interface | This independent Sharp/memoryStorage path must be coordinated or explicitly excluded from simultaneous-load acceptance; product-route optimization alone is not process-wide safety |
| [photo backup](../../apps/api/src/services/productPhotoBackup.ts) and [backup types](../../apps/api/src/repositories/product-photo-backup/types.ts) | Local primary photos, separate S3-compatible backup, SHA-256/size/manifest integrity, 16-MiB individual artifact cap; private intake/unreferenced files excluded | No S3/API/manifest change, keep canonical reference visibility and verify backup coverage with fake repository |
| [Admin page](../../apps/admin/src/app/products/[id]/photos/page.tsx) and [client](../../apps/admin/src/lib/productPhotos.ts) | Sequential per-file upload; primary/order/alt/delete endpoints unchanged; successful previous files not retried/rolled back; failure continues remaining files | Keep FormData/response contract; overload error displayed using existing error path; no automatic multipart POST retry |
| Publishing | Canonical ready photos, primary and order remain authoritative for eBay and Noctella Web | No provider mappings/payloads/URLs/readiness changes |

Current Multer/decoder failures do not all have a stable explicit route mapping: the route's
try/catch begins after upload.single, and app.ts has no final custom Multer error middleware.
Capture baseline statuses/bodies in tests before choosing normalized error responses. Do not
claim an existing 413 contract. Preserve current documented 400/201/auth/not-found contracts;
the proposed new overload/limit codes below require explicit review.

A separate issue in uploadProductPhoto's broad catch: deleteProductPhoto compensation also
covers work after the insert transaction (ensureSinglePrimary and final read). A future change
must distinguish pre-commit failure from post-commit failure. Never delete files referenced by
a committed ProductPhoto merely because the response lookup failed; reconcile instead.
Do not silently rewrite these business boundaries in a storage adapter.

## Proposed resource budgets (unvalidated acceptance targets)

MiB = 1024*1024 bytes. Values are candidate limits, not measured full-API allocations.

| Resource | One-transform candidate | Two-transform evaluation |
|---|---|---|
| Hard Linux cgroup memory / swap | memory.max=536870912, no swap (memory.swap.max=0 on v2) | same |
| Required peak acceptance | memory.peak <=384 MiB; zero new oom/oom_kill/max events; no restart | same, no relaxed headroom |
| Warm full-API baseline envelope | <=160 MiB observed cgroup memory, before image load | same |
| Active transform reservation | 128 MiB incremental allowance | 256 MiB if each still needs 128 MiB; would exhaust reserve and fails design arithmetic |
| Proposed file-cache/staging allowance | 48 MiB | 48 MiB |
| Other simultaneous API/job allowance | 48 MiB | 48 MiB |
| Uncommitted headroom | 128 MiB | zero with the above allowances: NOT accepted |
| Image pixels | <=24,000,000; positive dimensions; candidate max edge 12,000 | same |
| Image frames | preserve first-frame extraction (pages=1, animated=false); never enable all frames | same |
| Transform active count C | 1 | 2 only if measured lower incremental memory satisfies <=384-MiB gate |
| FIFO ready-file waiters Q | 2 | 2 |
| Request/job admission leases S=C+Q | 3 total, acquired before parsing or staged Buffer read | 4 total |
| Per-file / multipart metadata | 10 MiB, one file, at most one altText field <=8 KiB, two parts | same; limits beyond existing file cap need review |
| Staging disk candidate hard quota | 128 MiB private disk; never tmpfs | 192 MiB private disk for evaluation |
| Waiting / receive / processing deadlines | 5s ready-queue wait; 30s receive; 60s transform alarm | same; validate against latency distribution |

One-transform arithmetic: 160+128+48+48=384 MiB, leaving 128 of 512 MiB.
This is a planning partition, not additive maxima derived from P2-1. Cgroup peak captures all
charges, including file cache; disk staging can shift memory to cache and must still be measured.
V8 heap limits do not cap native Sharp memory. Do not set NODE_OPTIONS or global Sharp knobs
in this documentation PR. Avoid promising constant memory solely because input/output stream.

24 MP covers P2-1's 6000x4000 JPEG/WebP and 4032x3024 phone-sized synthetic inputs, excluding
64/144/289 MP stress. Raw 24-MP RGBA at 8 bits is ~91.6 MiB for one raster; multiple working
images/precision/decoder allocations make that **not** a transform bound. Test 12/20/24 MP
landscape and portrait, alpha, EXIF orientation, wide images and 24 MP + 1 boundaries. No real
representative-photo set was available; this limit must be owner-accepted after compatible,
consented non-customer samples or realistic synthetic substitutes are reviewed. Lower the cap
or redesign if constrained measurements miss the memory target; never raise the target to fit.

## Upload, decode and commit sequence

1. Existing auth and products.edit checks; resolve product existence before significant work.
   Try acquiring one of S leases synchronously before Multer. Full capacity returns proposed
   503 JSON { error: "Photo processing capacity is busy", code: "PHOTO_CAPACITY_BUSY" },
   Retry-After: 1. No body/file allocation or queued request promises beyond S. Complete error
   response then close/discard the rejected request safely; never drain unlimited bodies in RAM.
   Socket/proxy buffers remain outside these application counters and require load validation.
2. Create a server-owned random request directory mode0700, files0600, under a private disk
   staging root, separate from canonical serving and intake roots. Reserve disk bytes before
   accepting the body; enforce actual-byte counters, files/parts/fields limits, receive timeout.
   Use scoped Multer disk storage with exclusive server-selected filenames (wx), bounded stream
   buffers and custom abort handling; ordinary diskStorage alone does not supply these guarantees.
   Do not use client names, field ordering or supplied paths to derive trusted destinations.
3. Stage at most 10 MiB; validate actual stat size and declared MIME, close input descriptor.
   Admit at most Q completed files to FIFO while C are active; hold the S lease while receiving,
   waiting, processing and cleaning. A receive phase counts against S even before it joins FIFO.
   Queue timeout returns proposed 503 PHOTO_QUEUE_TIMEOUT and deletes staging. No auto retry.
4. Acquire active-transform permit before ANY Sharp metadata call. Construct Sharp with
   limitInputPixels:24_000_000, failOn:"error", pages:1 and animated:false, path input, rotate;
   reject absent/invalid dimensions or excessive edge before resize/encode. Repeat constructor
   pixel limits for every independently created input pipeline. Header checks are early guards,
   not a guarantee against dishonest metadata or codec memory bugs; hard memory gate remains.
   Preserve first-frame behaviour initially; rejecting animated WebP entirely is a separate
   compatibility decision. Confirm detected format policy (currently PNG declared JPEG works)
   rather than accidentally tightening MIME sniffing while changing transport.
5. Apply the existing main/thumb recipes sequentially; stream outputs to exclusive private
   temporary targets without whole-output toBuffer. Use real stream byte limits (proposed
   <=16 MiB each, aligned with backup cap), verify dimensions/type/size from outputs, and stop
   on quota overflow. New output caps must be approved; they can reject formerly accepted cases.
6. Move the complete pair into server-generated canonical names on the same filesystem using
   no-overwrite finalization. Individual renames are not an atomic pair: detect/reconcile a crash
   between them. Do not substitute cross-filesystem copy/unlink without its own failure tests.
   Keep old public URL/key conventions; insert metadata and promotion outbox only after both
   canonical files are prepared. Reuse the one existing product-row-lock persistence path.
7. Track ownership/commit state explicitly. Before DB commit, compensate only newly created,
   unreferenced files owned by this request. After commit, keep canonical files even on disconnect,
   response failure or cleanup failure; outbox/reconciliation owns their lifecycle. A lost response
   remains the existing uncertain-result case, not permission to blindly repeat upload.
8. Finally close descriptors, remove only disposable request staging, and release leases exactly
   once after physical work/cleanup settles. A native timeout alarm does not immediately release
   an active permit if Sharp is still running. Stop new admission and mark unhealthy on stuck
   work; await cancellation/settlement. A worker-process isolation redesign needs separate review.

Proposed pixel/edge violation: 400 PHOTO_PIXEL_LIMIT. Proposed over-file/part/output budget:
413 PHOTO_UPLOAD_LIMIT. Proposed local disk/quota unavailable: 503 PHOTO_STORAGE_UNAVAILABLE.
Preserve generic safe 500 behaviour for unexpected faults; never expose host paths or raw codec
messages. These mappings are NEW proposal decisions, to be tested/accepted before P2-2B.

## Shared admission and competing Sharp workloads

Process-wide means every permitted heavy image path participates, not a semaphore created per
request or one per storage instance. Current Sharp callers include canonical photoStorage,
private aiIntakePhotoStorage, and integrations/instagram/mediaPreparation.ts (including raw decode).
Inventory these before implementation; also account for native jobs such as reel preparation.

Acquire AI finalization permits before readStagedPhotoBytes, retain deterministic Buffer API,
process entries sequentially, and avoid nested acquisition/deadlock when the common processor is
called. Use a validated internal lease passed through orchestration; no externally supplied bypass.
Already-Finalized retries stay filesystem-free. Overload may delay/fail preparation before DB
mutation, but must preserve deterministic retry/conflict outcomes.

If another workflow cannot join the controller without changing its contracts, owner must approve
a separate integration or a proven mutual-exclusion policy and representative combined-load tests.
Until then, explicitly label the result product-route-only; do not claim process-wide 512-MiB safety.
Multiple Node processes/replicas each have counters; a shared filesystem needs its own quota/lease
coordination. Initial acceptance assumes one API process, to be verified rather than configured here.

## Cleanup and temporary disk accounting

For C=1,S=3: input reservations 3*10=30 MiB; active output pair <=32 MiB; scratch allowance 32
and quarantined-orphan allowance 32 give 126 MiB within a proposed 128-MiB staging quota.
For C=2,S=4: 40+64+32+32=168 MiB within 192 MiB. These are upper reservation targets, excluding
canonical data and backup/recovery workspace. Verify filesystem overhead/free-space reserve as well.
Application counters cannot hard-limit codec spill, crash leftovers or other writers: require a
real dedicated filesystem quota/volume bound or demonstrated equivalent before calling this bound
enforced. Prefer a directory/project quota on the canonical filesystem so finalization can rename.
A separate staging volume creates a cross-filesystem boundary and needs an explicitly tested copy/
finalization design before approval; do not assume rename works across mounts. No storage setting is changed now. TMP/TMPDIR for codec scratch must be process-scoped
at startup; never mutate global environment per concurrent request.

| Event | Required behaviour |
|---|---|
| Success / validation failure | Close streams; remove request staging; release reservations; retain committed canonical pair |
| Client abort / slow multipart | Stop parser and owned writes, await settlement, cleanup; no partial ProductPhoto row |
| ENOSPC / quota / partial output | Fail safely; remove owned partial files; no Ready/false success; retain unrelated photos |
| DB failure before commit | Remove only owned unreferenced canonical pair; keep original intake source |
| Response failure after commit | Keep canonical files/outbox; log reconcile identifier; no destructive compensation |
| Cleanup permission failure | Record safe operational error, quarantine and retain disk charge; close admissions if quota/accounting is unsafe |
| SIGTERM | Stop admission, drain finite active jobs within shutdown deadline, never release permit while native work continues |
| Hard kill / restart | Startup sweep private staging only with boot/session ownership, no-follow containment and active-lease checks |
| Stale private staging | Candidate TTL1h (above receive+queue+alarm); quarantine unknown entries; audit before deletion |
| Canonical orphan pair | Never include in staging sweep; DB-aware reconciliation with separate approval |

A startup sweep must not delete another live process's files; use exclusive root ownership or
cross-process leases. TTL alone is insufficient. Shutdown/interrupted pair tests are mandatory.
Never sweep PRODUCT_PHOTO_DIR, AI_INTAKE_PHOTO_DIR, backup objects or deterministic destinations
by filename age. P2-4a #376 remains separate; main still has cumulative recovery staging.
Serialize local restore/backup-heavy validation against upload load unless combined capacity is
measured; do not silently assume the proposed staging quota covers those workspaces.

## Offline Linux resource validation: BLOCKED

[Environment evidence](evidence/P2-2A-RESOURCE-VALIDATION.json) records local discovery.

- docker.exe exists; docker info and image listing both failed because
  dockerDesktopLinuxEngine named pipe is unavailable. No usable local engine/image inventory.
- wsl --list --verbose reported no installed distribution.
- No safe offline Linux runtime with an enforceable cgroup limit was available.
- No Docker/WSL installation, daemon configuration, image pull, production service or customer
  media was used. No new unrestricted Windows benchmark was substituted.
- Constrained-host results, full-API baseline, one-versus-two candidate measurements and
  representative-photo pixel acceptance: **NOT RUN / BLOCKED**. CI green does not replace these.

Future validation protocol, not executable acceptance evidence:

1. Prepare a cached Linux image offline with matching approved Node/Sharp/libvips/native SQLite
   dependencies and pinned source. Do not mount Windows node_modules. Disable networking, supply
   no real credentials; use only a disposable synthetic SQLite DB/private photo roots. Full app
   startup can run seed/migrations: assert every DB/storage path stays under the disposable root
   before importing app.ts. Audit and disable external scheduler/provider activity.
2. Start exactly one container with --pull=never --network=none --memory=512m
   --memory-swap=512m --cpus=1 and a disk-backed disposable bind volume. Equal memory/swap values
   disable swap under Docker's documented semantics. Verify inside cgroup v2 memory.max=536870912,
   memory.swap.max=0 and finite limits; capture cgroup version, CPU quota, versions and image digest.
   Abort if enforcement is unavailable. Do not use tmpfs for staging; its charges undermine memory.
3. Measure warmed full-API idle plus synthetic ordinary API workload separately, then actual HTTP
   multipart uploads through isolated app on loopback with synthetic auth fixtures. Collect
   memory.current/peak/stat and event deltas (max/oom/oom_kill), process RSS/heap/external/ArrayBuffer,
   latency/throughput, disk high-water/leftovers, queue depth, permits and response classifications.
   Keep container after exit long enough to inspect OOMKilled and exit status.
4. Compare baseline unmodified route vs later P2-2B candidate, fresh container per trial, C=1 vs2;
   10+ sequential and 1/2/4 clients with accepted pixels, near 10-MiB JPEG/PNG/WebP, EXIF/alpha and
   malformed/24 MP + 1/stress input. Run at least three trials plus a 30-minute mixed synthetic soak;
   warm-up separately, report median/worst and workload distribution. Generate big fixtures
   outside the measured container; stream inputs in a client outside API cgroup.
5. Candidate passes only if every trial peak<=384 MiB, zero new cgroup memory-limit/OOM events,
   no restarts/corruption/leaks/unbounded queues, accepted workload baseline <=160 MiB, quotas and
   cleanup hold, and synthetic normal API latency remains within separately approved SLO.
   If C=2 fails while C=1 passes, choose1; if both fail, block deployment and revise design.
   Record actual measures, not planning partitions; no production probe is required.

Technical checks consulted October 13: [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/)
supports path input and limitInputPixels, with a metadata-trust caveat; local locked 0.34.5 source
also confirms pages=1/animated=false defaults. [Multer](https://github.com/expressjs/multer/blob/main/README.md)
provides disk storage and multipart limits; it is not an application-wide admission/quota controller.
[Docker memory constraints](https://docs.docker.com/engine/containers/resource_constraints/) describe
hard memory/swap controls. Revalidate against pinned implementation during P2-2B; no dependency
upgrade is part of this proposal.

## P2-2B implementation sequence (requires separate authorization)

1. Review/accept new pixel, edge, metadata/output, overload and timing policies; resolve shared
   Sharp caller scope, one-process assumption, physical staging quota and constrained Linux access.
2. Establish failing contract/failure tests and reproducible constrained baseline. Do not change
   runtime while P2-2A is only a proposal. Select candidate thresholds from representative evidence.
3. Implement lifecycle/admission and private staged-path capability first; preserve Buffer methods
   and injected mocks. Refactor common persistence once, preserving row-lock and dialect semantics.
4. Add path-based transform/output staging with recipe parity and ownership-aware commit/cleanup.
   Integrate deterministic AI-intake lease before staged read without changing keys/fast retries.
5. Add quotas, finite wait/receive policy, abort handling, shutdown and safe private orphan sweep;
   explicitly integrate or exclude competing Sharp paths. Capture new error contract snapshots.
6. Run the matrix below and constrained protocol; produce before/after data and independent CI.
   Separate Draft runtime PR must state unresolved failures, rollout and rollback.
7. Owner reviews actual evidence and explicitly approves any merge, staging/production rollout
   or infrastructure setting. No automatic rollout follows documentation or CI approval.

## P2-2B regression/failure acceptance matrix

| Area | Deterministic tests / evidence required |
|---|---|
| Route/auth/form | Unauthorized/missing permission before staging; absent photo400; file limit boundary +/-1; extra files/fields; malformed MIME/boundary; altText unicode; baseline and proposed error snapshots |
| Decode | JPEG/PNG/WebP portrait/landscape/alpha/EXIF; near 10MiB; 24MP and24 MP + 1; edge limits; truncated/empty/spoofed input; first-frame policy; no expensive transform after rejection |
| Admission | Barrier-controlled C=1/2; S cap pre-parser; Q FIFO/deadline; 4+ clients; abort at each phase; counters exactly once; reentrant lease misuse; no native work after permit release |
| Filesystem | wx collisions/traversal/symlink; ENOSPC at input/main/thumb/finalization; quota overflow; cleanup EACCES; interrupted pair; restart; staging vs canonical root separation |
| Transaction | Same-product concurrent uploads/finalization; stable first-primary/order; pre/postcommit fault injection; no deletion of committed/referenced photos; SQLite sync vs PostgreSQL async constraints |
| AI intake | Existing finalization, restart, collision, content, retention tests; deterministic byte parity and source preservation; alreadyFinalized no FS; admission before Buffer read |
| Outbox | Same-root no delete; Ready only both files; retry/lock recovery; legacy thumbnail repair; scheduler and restart persistence |
| Backup/recovery | Fake S3 only; canonical main/thumb coverage; unchanged hashes/manifest/schema; no staged/private references; independently retain #376 behaviour when integrated |
| Existing channels/Admin | eBay/Web publishing and primary readiness, order/alt/delete, sequential UI/failure continuation; no auto retry of succeeded files |
| Resource | Enforced512MiB, warmed full app, 3 trials+soak, C=1/2, cgroup/RSS/native proxies, latency, disk peak and cleanup; no customer media |

Existing suites to retain include productPhotos.test.ts, productPhotoRestartPersistence.test.ts,
productPhotoOutboxWorkflow.test.ts, productPhotoOutboxStaleLockRecovery.test.ts,
productPhotoOutboxScheduler.test.ts, productPhotoBackup.test.ts, aiIntakePhotoFinalize.test.ts,
aiIntakePhotoFinalizeRestartPersistence.test.ts, aiIntakePhotoFinalizeRouteSprint95.test.ts,
aiIntakePhotos.test.ts, aiIntakePhotoContent.test.ts, publishing.test.ts and marketplacePublishing.test.ts
under apps/api/tests, plus Admin products/[id]/photos/page.test.tsx. Exact selected count is recorded
in P2-2B; P2-1's 713 tests are historical evidence, not a new run for this documentation PR.

## Rollback, approvals and documentation validation

This PR changes docs/evidence only; rollback is reverting its documentation commit. No migrations,
settings, credentials, buckets, data or service changes need reversal.

Future runtime rollback: stop new admission and drain jobs, preserve committed canonical pairs and
outbox entries, retain orphan/quarantine evidence, restore reviewed code while preserving keys/URLs.
Do not automatically re-enable unbounded memory uploads on a failing 512-MiB service; fail closed
temporarily if required. A feature flag must not bypass pixel/admission protection while jobs run.
Any code/config rollback or staging volume provisioning needs its own owner-approved execution plan.

Open gates: Linux enforced-limit environment; representative pixel acceptance; full-API baseline
and combined workload coverage; quota feasibility; proposed errors/timeouts/SLOs; one/two active
selection; partial-pair/postcommit reconciliation; shared admission integration; P2-2B authorization.
Historical OOM cause remains unknown. No production changes are implied by accepting the design.

Applicable local checks: relative Markdown link existence, fenced-block balance, numeric budget
arithmetic and documentation-only Git diff/whitespace review. No Markdown lint script is configured.
Runtime tests/builds are NOT RUN for a documentation-only change; unchanged CI workflow is triggered
by the Draft PR and its actual status is reported separately, not called constrained-host acceptance.
