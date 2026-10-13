# P2-2B2A: shared image admission foundation; resource acceptance FAILED

Tracking: #387; parent #384. Stacked on #386 at 47b32ddd60348393597238c741400d48828f7c62. Base branch: feat/photo-upload-bounded-memory-p2-2b1. This work does not modify the base branch or enable production behavior.

## Policy and ownership

PRODUCT_PHOTO_DISK_STAGING_ENABLED remains disabled by default. When enabled, all audited production Sharp entry paths use imageProcessingAdmission; productPhotoAdmission is a compatibility alias to the same object. One active orchestration scope owns transform capacity, with at most three globally reserved slots including the active scope, queued scopes, receiving disk uploads and internal forks. Ready scopes use FIFO, five-second queue waits and the existing 60-second alarm. The alarm closes admission but cannot release native work early.

AsyncLocalStorage ownership is created only by reserve().run. It is never accepted from HTTP fields or API callers. runImageScope orchestrates reads/leaf APIs without taking a nested transform permit; runImageOperation wraps a complete leaf operation. A leaf cannot recursively invoke another leaf: it fails with IMAGE_ADMISSION_NESTED instead of deadlocking. Concurrent orchestration forks serialize, reserve extra slots from the same global budget, and have finite waits/abort/shutdown cancellation. Canceled callbacks release their captured work reference. Expired ownership cannot be reused by delayed async children. Even detached leaf work drains before the outer permit releases.

The shared recipe additionally checks private operation ownership when enabled. This protects existing helper callers from accidentally starting unowned processing; it is not a general interception of arbitrary future Sharp imports. A source inventory regression requires review when a new production Sharp entry file appears.

An orchestration scope can encompass DB/file operations and an entire AI finalization album, so the 60-second alarm is a scope alarm, not a per-image deadline. Large albums or slow DB/storage can close admission or time out other requests. Current sequential AI preparation never forks; all source reads and deterministic writes remain outside the DB transaction.

Flag OFF bypasses new admission wrappers and retains legacy product/AI multipart routes. Operational/social callers do not fail merely because the shared controller closed. Configuration changes require restart; changing process.env in an active process is not a supported live toggle.

## Audited entry paths

| Entry | Enabled behavior | Preserved contracts |
| --- | --- | --- |
| Product HTTP disk upload and LocalStagedProductPhotoStorage | Reserve before multipart, active ownership before Sharp; native file output remains | 201 ProductPhoto, IDs, keys, URLs, order, primary, alt, input/pixel limits |
| LocalPhotoStorage.saveProductPhoto | Complete Buffer processing/write leaf | Existing Buffer API, recipe and original size metadata |
| writeDeterministicProductPhoto | Complete deterministic processing/comparison/write leaf | Exact canonical keys, same-byte retries, conflicts, no source deletion |
| AI upload HTTP | Reuses private disk ingress in a separate .ai-intake-upload-ingress sibling; reads Buffer only after active capacity | Existing uploadIntakePhoto and AiIntakePhotoStorage Buffer APIs; trusted authenticated actor and original filename |
| LocalAiIntakePhotoStorage.saveIntakePhoto | Complete native leaf; enabled output uses exclusive owned path and cleans its own failed partial output | UUID storage key, rotate/WebP86, original dimensions and existing input rules |
| finalizeAiIntakePhotos default manifest preparation | Active scope before staged reads; each read/write is a leaf; already-finalized retries skip preparation/admission entirely | Deterministic IDs, ordered/primary manifest, source retention, transaction/outbox semantics |
| Instagram prepareInstagramImageAsset / prepareInstagramImage | Leaf before source/derivative Buffer reads, metadata, decode and JPEG conversion; private helpers remain inside that leaf | Source fingerprint, immutable recipes, no-clobber publication, URLs and in-flight retry semantics |
| inspectPreparedInstagramImage | Leaf before source/cached-derivative reads and raw validation | Invalid asset result and sanitized OS-error behavior |
| photoProcessingRecipe | Internal constructor requires owned leaf when enabled | Identical rotate/resize/WebP recipe |

Instagram capacity/queue/ownership pressure is a retryable InstagramClientError(processing,true), outside the existing invalid-media catch. Native/file invalid-media failures keep their prior classification. AI HTTP/finalization uses safe PhotoUploadError JSON and Retry-After:1 for503. No provider client, credential, publishing payload or marketplace write is changed.

The enabled AI multipart path normalizes malformed/oversize/extra-field responses through the existing B1 handler (400/408/413/503). It allows photo and optional altText; actor identity comes exclusively from authenticated req.adminUser, never multipart input. The legacy flag-OFF path and its error behavior remain. Shared ingress uses the existing software reservation model; no hard quota or recovery migration is added.

## Memory coverage and exclusions

Audited Sharp constructor/call files: services/photoProcessingRecipe.ts, photoStorage.ts, stagedProductPhotoStorage.ts, aiIntakePhotoStorage.ts and integrations/instagram/mediaPreparation.ts. Public processing results do not expose Sharp builders. Node/libvips internal threads and codec caches still consume native memory within an admitted operation.

Capacity precedes product/AI HTTP disk-to-Buffer reads, deterministic finalization default reads and Instagram local reads. Buffer APIs necessarily receive caller-owned Buffers already allocated; upstream callers remain responsible for those lifetimes. Admin content reads and general LocalAiIntakePhotoReader/provider reads outside deterministic finalization are not transform admission and can return Buffers to other consumers. Future providers must not assume this controller limits their retained/network buffers.

integrations/media/reelRenderer.ts runs FFmpeg as a subprocess. Its existing subprocess/encoding controls are separate from image admission and is NOT admitted by this Sharp controller. Reel publishing preparation that invokes Instagram image helpers is covered; FFmpeg itself is not. Database caches, backup/recovery I/O, HTTP connections, analytics and other native/runtime users are not covered. This is a shared Sharp concurrency policy, not a bound on total process memory.

AI original-size conversion retains its existing decoded-pixel rules; Instagram retains40-MP source rules. B1 product24-MP/12000px limits are unchanged. One active transform alone cannot make every formerly accepted AI image safe within512MiB. Those format/pixel and total-memory acceptance gates remain.

## Lifecycle and compatibility verification

New controller tests cover shared identity, FIFO/global boundedness, borrowed ownership, serialized forks within the same capacity budget, nested failure without deadlock, stale/detached async work, root/internal wait timeouts, queued cancellation, abort/native settlement, alarm, shutdown and fresh-process recovery.

Real-app tests run authenticated product upload concurrently with AI deterministic finalization and local-only Instagram preparation. Delayed native Promise instrumentation detects overlap and requires peak native calls=1. They check original AI filename/actor, private ingress cleanup, deterministic photo ID, source retention, outbox/row counts, finalized retry with full capacity, retryable Instagram overload, exclusively owned AI partial cleanup and actual flag-OFF legacy storage/Instagram operation after controller close.

Existing product, photo outbox/restart/backup, AI intake/finalization/restart and Instagram preparation/approval/pending-recovery/social/reel suites run as regressions. No production configuration is changed. CI filters include the stacked base branch; the original #386 workflow/branch is untouched.

## Offline resource validation

The existing Linux512-MiB/no-swap/network-none/read-only-root harness has an explicit combined profile: three fresh containers, eight image operations each, one synthetic near-limit24-MP JPEG fixture pinned from #379. It seeds isolated SQLite/auth and Applied AI state without calling any AI/provider service.

Each trial runs setup product/AI HTTP uploads, then three-way product HTTP + AI HTTP ingress + local Instagram preparation, followed by product HTTP + AI finalize HTTP + Instagram derivative inspection. It asserts one observed native call, preserved AI source hash/photo ID, four photo rows/outbox events, two retained AI sources and nine canonical/derivative files. Client uploads stream; integrity hashes stream too. Baseline and partial progress are written before/through work, and the external observer retains exact cgroup peaks/events, RSS, exits and disk even on OOM.

The unchanged384-MiB cgroup target is required for a pass. Results are recorded separately after actual execution. These trials exclude provider calls, FFmpeg, production PostgreSQL/traffic, soak and adversarial connections. Native Promise instrumentation and in-process clients add overhead. Do not infer production readiness or historical OOM causation.

Run via explicit workflow_dispatch profile=combined, or same-repository PR title edit prefix [run-upload-512m] combined-only. Ordinary PR updates run only fast policy tests. No automatic35-scenario benchmark.

## Risks, rollback and remaining gates

- Keep the feature disabled. Full API repeated/soak/adversarial/FFmpeg/background/backup combined acceptance, representative AI/Instagram decoded limits, and reviewed operational enablement remain.
- Whole-album/DB scope duration can cause pressure/timeouts; admission closes on the alarm and must not be reopened while old native work survives. Restart only after drain/recovery.
- Existing deterministic write/DB commit ambiguity and file-orphan recovery are unchanged; this task adds no hard disk quota or canonical reconciliation. B1 fail-closed persistence and saved-photo safeguards remain.
- Private AI input/output staging needs the later disk budget/quota/recovery work. Failed owned native output is removed; unknown cleanup failure is surfaced, not silently declared successful.
- Existing encoded/decode/output limits and Buffer APIs are preserved; arbitrary caller-held inputs and FFmpeg can still exceed total-memory targets.
- Roll back by keeping/unsetting the flag and restarting. Revert this stacked change to restore B1 product-only admission if needed; no DB migration or key rewrite. Preserve/reconcile private inventory under the B1 operational plan; never delete canonical/source files blindly.
- Parent head movement requires an explicit isolated rebase and revalidation; do not update #386 in this task. No merge, deploy, production access, provider writes or infrastructure changes.

## Actual acceptance failure (do not enable)
Runtime973b66f / Actions38439169032 / artifact11833589757 (ZIP SHA256 ea1cb71a3e61bd3460b600b1253c6df9f9993468a618a0e97212c8a2e0113936): all three24-MP combined trials hit512MiB cgroup peak, exit137, and one OOM kill each. max counter deltas120/121/126. Last checkpoints recorded four of eight completed operations and nativePeak1; the second AI upload was outstanding. Finalization/wave2 and application integrity/cleanup assertions were never reached. Host disposable cleanup completed; that is not application crash recovery.
These results fail the unchanged384MiB target and are not production measurements. Shared admission is not sufficient total-memory protection. We retain the existing AI decoded-size/recipe rules rather than silently lowering acceptance inputs or changing customer behavior. A single12-MP combined-reference case is diagnostic-only; even if it passes, the24-MP gate remains FAILED. No failed24-MP trial is relabeled or discarded. Full P2-2B2 remains open; this Draft is a reviewable B2A foundation.
