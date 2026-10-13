# P2-2B2C — native AI allocation diagnosis; acceptance BLOCKED

Tracking [#393](https://github.com/yali-code/noctella-web/issues/393), continuing blocked #390. [Draft #394](https://github.com/yali-code/noctella-web/pull/394) is stacked on #392 at 6eca0afcda2ee5a96126818234b4429f5ae9ecfd. All parent heads are preserved.

**Diagnosis-only delivery, as expressly allowed by #393. No safe recipe-compatible runtime optimization met the 384-MiB gate. Production routes/services and flag defaults are unchanged.** This report identifies measured allocation contributors, tests two isolated alternatives, and preserves three failed final acceptance trials. It does not claim production readiness or an exhaustive proof that every possible optimization must fail.

## What changed

Only offline benchmark/profiling tools, their tests, stacked CI branch filters and evidence:

- A glibc-only, opt-in LD_PRELOAD tracer records requested allocations >=1MiB, pointer lifetimes, thread IDs and native call sites. It is built only into the dedicated offline test image; no API entry point loads it. Diagnostic overhead is separated from uninstrumented acceptance.
- A bounded lifetime analyzer distinguishes live requested bytes from cumulative allocations and process RSS. Duplicate/overlapping/malformed/capped evidence fails closed. Small allocations/direct mmap and some bootstrap activity remain unobserved.
- An explicitly diagnostic AI conversion child and a separate glibc mmap/trim policy compare the same recipe/input/workflow. No experiment is selected by HTTP input or imported into production storage.
- Phase checkpoints include Sharp counters/concurrency/cache, admission, process RSS/HWM/heap/external/ArrayBuffers, allocator settings and cgroup current/peak/events/stat. The host records all cgroup processes and a bounded post-run file inventory before disposable cleanup.
- Final acceptance hashes actual input bytes and rejects worker, preload, tracer or MALLOC overrides. Mode records distinguish acceptance from diagnostics. Threshold, input limit, pixels, quality and workload are unchanged.

## Environment and unchanged workload

GitHub Ubuntu24.04; Node20.20.0, Sharp0.34.5/libvips8.17.3/WebP1.6.0. Each case uses a fresh exact536870912-byte cgroup, swap.max0, Docker network none/loopback only, readonly root, CPU1, pids128, dropped capabilities and no-new-privileges. Only fixtures readonly, disposable work and evidence mounts exist. All measured children remain in that same cgroup.

Pinned P2-1 generator:7c6ab55237e996fef041c60bb06f45b7d0fc2061. Input:6000x4000 JPEG,9,670,997 bytes, SHA256 **2f2f90eb7060b031815c5afc8503e2914b2e7eb398b29eabfd23330443c441c7**. Generation is outside measured cgroups.

The original eight operations remain: product setup, AI setup upload; simultaneous product upload/AI upload/Instagram preparation; simultaneous product upload/AI finalization/Instagram inspection. Real authenticated API/SQLite and local-only Instagram helpers, streaming synthetic multipart clients, existing deterministic IDs/source hashes/outbox/cleanup assertions. No provider writes, production DB, customer media, Render or infrastructure changes.

## Measured native allocations

[Allocator diagnostic run38450912055](https://github.com/yali-code/noctella-web/actions/runs/38450912055), revision b10bb5cea9f1cf47cc3f39f6c9adab9348f35126. Overall512MiB, exit137, one OOM kill,113 new max events,4/8 operations. The first AI conversion alone reached501.10MiB cgroup before completing; this is diagnostic evidence, not an uninstrumented acceptance measurement.

The218 native events yield a **329.16MiB peak of concurrently live requested large allocations** (345,154,266 bytes). At kill,276.09MiB (289,504,154 bytes) remain tracked. These are requested allocation sizes, **not physical/resident memory** and not added arithmetically to RSS. Two untracked free events are retained in the analyzer result; no failed allocation is observed before the kernel kill.

| Observed native allocation family | Allocations / frees | Maximum live | Live at kill |
| --- | --- | --- | --- |
|3,975,008-byte pages; libvips-cpp callsite0x4cb3e3|102 /58|58 pages,219.87MiB|44 pages,166.80MiB|
|72,000,000-byte blocks; callsite0x15a56f|2 /1|1 block,68.66MiB|1 block|
|36,000,000-byte blocks; callsite0x4aa2d2|2 /1|1 block,34.33MiB|1 block|

All58 first-conversion pages have matching frees before the second conversion; the second uses a different native thread (first59, second61). No overlap of the two large page sets is observed. Other frame-sized blocks also have matching first-conversion frees. This contradicts a claim that the first encoder's large objects simply remain logically live or that two admitted encoders run together. It does not prove glibc returned the pages to the OS, nor exclude small-object/mapping/cache residency.

The [pinned WebP encoder](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/enc/webp_enc.c) derives token-page capacity from macroblocks and quality. Together with its [token-page allocator](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/enc/token_enc.c), the6000x4000/Q86 calculation is375x250 macroblocks,1,987,500 two-byte tokens plus an8-byte link: exactly3,975,008 bytes. This is a strong match to the repeated measured family, **not a recovered function symbol**: the bundled library is stripped and the trace identifies offsets rather than the internal function name.

The72M/36M sizes are consistent with a full RGB frame and YUV420 picture. [libvips WebP saving](https://raw.githubusercontent.com/libvips/libvips/v8.17.3/libvips/foreign/webpsave.c) uses full-frame storage and an encoded-memory writer, including file output. Exact object attribution for those stripped callsites remains an inference. No allocator-specific leak or historical production OOM cause is claimed.

Before the second encoder, the allocator diagnostic records290.51MiB cgroup current,42.95MiB JS heap and6.34MiB external memory. Large native requests grow during that operation until OOM. The repeated page family is substantial measured pressure, while post-free residency and baseline/native allocation interaction remain partly unresolved.

## Rejected recipe-compatible experiments

| Diagnostic | Run / revision | Cgroup peak | OOM / max events | Workflow result |
| --- | --- | --- | --- | --- |
|Fresh AI recipe process, same cgroup|[38452470778](https://github.com/yali-code/noctella-web/actions/runs/38452470778),3a76be6|512MiB|1 kill /256 max|4 expected successes plus AI wave1 HTTP500; wave2 not reached|
|MALLOC_MMAP_THRESHOLD_=131072 and MALLOC_TRIM_THRESHOLD_=131072, only inside experiment|[38452930020](https://github.com/yali-code/noctella-web/actions/runs/38452930020),1c85e89|488.75MiB|0 OOM /0 max|8/8, exit0; fails384MiB target|

The child reads its own and parent's cgroup identity and verifies memory/swap limits before conversion. The host observer sees both Node processes under the same cgroup. First child completes; the second is killed. The parent survives, awaits actual child close and surfaces a failed upload. The outer probe exits2 because a workflow failed; that is distinct from the cgroup OOM event. No claim is made that a child moves memory outside the budget or safely isolates production failures. Diagnostic process controls have crash/abort/timeout/output-budget regressions.

The allocator-policy trial completes the unchanged workload with nativePeak1 over24 calls; four canonical photo rows/outbox events, two retained AI sources, deterministic identity/source hash, nine canonical/derivative files and empty temporary roots pass. Process RSS/HWM508.15MiB; heap44.32MiB, external46.29MiB, ArrayBuffers41.23MiB. Work disk peak38,389,035 bytes logical /38,420,480 allocated; duration14,941ms includes setup, queues, HTTP, DB and transforms, not pure Sharp time.

Before its second encoder, cgroup current is168.66MiB versus290.51MiB in the allocator-traced case. Runs differ in instrumentation/environment and are single trials; this is not an isolated numerical attribution to one allocator mechanism. The policy changed completion/OOM behavior in this experiment, supporting allocator sensitivity, but **488.75MiB still exceeds the unchanged target by104.75MiB**. It is not deployed, selected or accepted.

The first retained AI source SHA is identical in worker, allocator-policy and all final default trials: **c7a66870d873374abef3c0da90a4e06db4865e25ceb4dd360f2c93e659cf07dc**. This establishes byte fidelity for that original fixture/conversion, not a complete representative-photo corpus.

## Final uninstrumented three-trial acceptance — BLOCKED

Revision **d5533c70b3d33bd231eeae30ae87b7a84c880f66**, [run38453886727](https://github.com/yali-code/noctella-web/actions/runs/38453886727). Subsequent commits add documentation/evidence only; measured source, harness and tests remain unchanged.

Each measurement-mode.json verifies actual input SHA/dimensions/bytes,8 operations, WebP86/auto-orientation/no resizing, nativeTrace=false, recipeWorker=false, mmapPolicy=false and empty allocator overrides. No LD_PRELOAD or experimental policy is loaded.

| Trial | Peak MiB | Exit | New max /oom /oom_kill | Completed | Required final integrity/cleanup assertions |
| --- | --- | --- | --- | --- | --- |
|1|512|137|117 /1 /1|4/8|Not reached|
|2|512|137|200 /2 /1|3/8|Not reached|
|3|512|137|116 /1 /1|4/8|Not reached|

Last checkpoints nativePeak1; the second AI encoder is outstanding. Final heap/external/ArrayBuffer peaks are unavailable after kill. Observer sampled process RSS/HWM554.50/551.40–551.56/552.71MiB; RSS and cgroup accounting differ, so cgroup peak/events govern acceptance.

Post-OOM inventories explicitly retain a9,670,997-byte AI ingress input and a zero-byte reserved AI output in every trial; trial2 also retains a product ingress input. Host disposable cleanup succeeds, but this is **not application crash cleanup or recovery acceptance**. All final DB/outbox/integrity assertions were skipped by process death; they must not be inferred from scoped tests or the allocator diagnostic.

There is no final default-path peak improvement: parent and final trials all cap at512MiB. The384MiB gate remains unmet; #390 remains open.

## Preserved evidence and reproducibility

Adjacent directories contain complete original expanded artifacts: preflight, Docker/source provenance, fixture metadata, raw allocator stacks/events and derived summary, phase traces, observer samples, progress/results, worker records, inventories and logs. No failed run is omitted. Locally downloaded ZIPs were hash-verified and preserved outside the checkout. Expanded Git text can have normalized line endings; original ZIP digests identify original bytes.

| Artifact | SHA256 |
| --- | --- |
|11839894502 allocator|edd352417df0c816397001e4ca22506bc16ef767ef99e84d4ea0efcb73ee0499|
|11840449530 worker|05466d0fa6519437f374e0d4b68bfa8c5b0afac661ee2340bd196d219f55f1db|
|11840523214 mmap-policy|03534218743ecbf3b6194dc966655a9b7692fd7af0bd6894fffaa7ce932c6d11|
|11842016702 final three trials|4193d7d8cb59b5d389c3b9378846805d7481775653fcf9eb8fae606cf8db521e|

The large-allocation tracer changes timing and makes temporary diagnostic allocations; its backtraces are incomplete for stripped libraries. It excludes small allocations/direct mappings and does not measure allocator usable/free pages as resident bytes. There is no claim of zero instrumentation overhead. Ordinary acceptance excludes that tracer and both alternatives; lightweight phase/host sampling remains consistent with the parent methodology. Single diagnostic trials are not acceptance/soak or production measurements.

## Validation, compatibility and next work

-21 offline policy/analyzer/worker tests pass, including allocator-override rejection, exact fixture/workload checks, lifetime accounting, malformed/capped evidence, child crash/nonzero exit/invalid output, bounded output, abort, timeout and physical-close ownership.
-Linux Docker build compiles the tracer with warnings-as-errors and passes real malloc/calloc/realloc/free and disabled-by-default smoke checks outside measured cases.
-27 inherited AI staged/shared-admission/inventory/actual product-AI-Instagram workflow regressions pass, including failure, cleanup, timeout, shutdown, deterministic retries and flag-OFF behavior.
-API typecheck/build and repository lint pass; existing Admin image warnings remain. Full repository CI, Admin/Storefront/PostgreSQL results and final-head status are linked in Draft #394.

Production upload, finalization, storage keys, IDs, canonical bytes/recipes, transactions/outbox, retries/source retention, provider integration and default feature flag are unchanged. No runtime worker, allocator setting or native override is enabled. No customer media or external provider calls.

The next eligible implementation must reduce the original encoder's live footprint/residency without changing photo quality/resolution/canonical content. The [native codec configuration](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/webp/encode.h) has a low-memory mode, but it is not a proven byte-compatible fix through the installed Sharp/libvips interface. Lower effort/quality, resolution changes, undocumented native hooks or moving worker memory outside the cgroup are not selected. A codec-facing adaptation needs measured fidelity and lifecycle validation, then three unchanged full-gate trials. This report does not claim such a fix is impossible.

Rollback: revert this diagnosis-only stacked PR; no schema/key/storage migration or production configuration change exists. Keep PRODUCT_PHOTO_DISK_STAGING_ENABLED unset/false and restart for any future policy change. Preserve/reconcile retained/canonical/ambiguous inventory using existing procedures; do not blindly retry or delete after process death. Quotas, orphan recovery and Etsy #391 remain outside this work.
