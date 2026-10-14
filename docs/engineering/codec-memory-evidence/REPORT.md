# P2-2B2D codec-side feasibility — Issue #395

Draft [#397](https://github.com/yali-code/noctella-web/pull/397), stacked on [#394](https://github.com/yali-code/noctella-web/pull/394) at `14af8ce3da0efc3599cb60ade2788da2195411e6`. No application runtime changes. Production feature remains OFF by default. Issue #396 is outside this work.

## Source findings and candidate mechanism

The pinned stack is Sharp 0.34.5, libvips 8.17.3 and libwebp 1.6.0. The parent's large-allocation traces measured repeated 3,975,008-byte allocations and matching frees, not a proven logical leak. The exact internal symbols in that stripped binary remain unresolved; requested allocations are not RSS.

The [libwebp encoder source](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/enc/webp_enc.c) enables token buffering at method >=3 unless `low_memory` is set. At 6000×4000/Q86 its token-page formula yields 1,987,500 two-byte entries plus an eight-byte link, matching the observed page size. This source match supports the token-buffer hypothesis without proving the historical allocation's symbol. Lowering process transform concurrency cannot remove a single encoder's token storage; parent admission already allows one active transform.

The [public codec configuration](https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/src/webp/encode.h) offers `low_memory` as a memory/CPU tradeoff. The [pinned libvips saver](https://raw.githubusercontent.com/libvips/libvips/v8.17.3/libvips/foreign/webpsave.c) does not expose that field. Sharp's public WebP options do not expose it either. Method/effort 4 is the current default. Effort reductions, reduced color precision, resizing and quality reductions are not adopted as substitutes for the current recipe. Those exclusions are source/design constraints, not measured negative experiments.

## Isolated experiment

The offline Docker image builds the official libwebp 1.6.0 archive with SHA256 `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`. CMake cache, compiler, static library/binary hashes and dynamic links are recorded. This diagnostic binary is separate from Sharp's bundled library and never imported into application routes/services.

Preparation uses the unchanged fixture SHA256 `2f2f90eb7060b031815c5afc8503e2914b2e7eb398b29eabfd23330443c441c7`, 9,670,997-byte 6000×4000 JPEG. Sharp auto-orients it to a 72,000,000-byte RGB file and separately emits the existing quality-86 WebP reference. Preparation and decoded-pixel analysis run in disposable 2-GiB containers; their measurements are NOT constrained-host acceptance evidence.

Two fresh codec-only containers enforce memory.max=536870912 and memory.swap.max=0, network none, CPU1, pids128, dropped capabilities, read-only root and non-root identity. The native probe verifies actual limits and exact RGB size, imports RGB, frees its input allocation before encoding, and writes directly to an exclusively created output file. Both use preset DEFAULT, quality86, method4, alpha_quality100, pass1 and no resize; only `low_memory` differs. Direct file writing and RGB lifetime are common to both controls, so the option comparison does not attribute their benefits to low_memory. Input file cache was prepared outside the measured cgroups; codec peaks are not whole-pipeline peaks.

The host records before/after cgroup limits, peak/events, exit codes, process RSS high-water mark, encoder duration, output sizes/hashes, decoded RGB errors and metadata. Generated inputs and outputs are preserved in a separate complete Actions artifact. These are synthetic diagnostic files, not customer photos. Timeout kills are bounded; the keepalive container preserves cgroup evidence after a child failure, and workflow cleanup removes only this run's disposable containers.

## Results

**Acceptance: BLOCKED. This is a feasibility-only delivery; no runtime optimization is selected.**

Measured source revision: `d10f1c275a85d451b981b0826644d94a186df10a`, [run38537514014](https://github.com/yali-code/noctella-web/actions/runs/38537514014). Subsequent delivery changes contain only documentation/raw evidence; application, harness and native diagnostic source remain identical to this measured revision.

| Codec-only diagnostic | Cgroup peak MiB | Process RSS HWM MiB | Encoder seconds | Output bytes | Exit / new max,oom,kill |
| --- | ---: | ---: | ---: | ---: | --- |
| low_memory=0, method4/Q86 | 255.5977 | 256.3398 | 2.474870 | 10,463,844 | 0 / 0,0,0 |
| low_memory=1, method4/Q86 | 104.5508 | 105.0703 | 8.254442 | 10,141,098 | 0 / 0,0,0 |

The option saved151.0469MiB (59.10%) of observed codec-only cgroup peak and took3.3353x as long in this one paired diagnostic. Encoder timing excludes input read/RGB import; RSS HWM covers the entire native process. These are single-case observations, not statistical performance estimates or whole-API predictions. There was no preload, allocator override or alternate workload. The codec result includes original geometry/Q86/method4, and actual memory/swap enforcement and raw counters are retained.

**Fidelity prevents calling this a transparent recipe-preserving replacement.** The normal native control exactly matches Sharp's existing output SHA256 `c7a66870d873374abef3c0da90a4e06db4865e25ceb4dd360f2c93e659cf07dc` and all72,000,000 decoded RGB samples. This validates the control bridge/compiler result for this fixture. The low-memory output is `52c859a9622dd806cb51cd90147653e4d12261e33fe68ccaa12f6825c00b7a02`;43,121,088/72,000,000 decoded samples differ (59.89%), maximum absolute channel error23, MSE4.916989, PSNR41.213811dB relative to the existing encoded image. Format WebP,6000×4000,sRGB,three8-bit channels,no alpha/no ICC profile and oriented dimensions match on this fixture. It is not bitwise or decoded-pixel identical.

A separately labelled Windows post-analysis against the original oriented RGB yields PSNR35.634019dB for the control and35.458813dB for low-memory, a0.175206dB reduction on this synthetic image; max channel errors29/30. This is fidelity analysis only, not a Windows memory measurement or a perceptual/metadata compatibility approval for real photos. It uses the retained raw input and the same compareSamples metric; decoder versions are recorded. Quality86/method4 alone are insufficient to assert identical fidelity.

**Decision:** low_memory has a measured useful native-memory effect, but is rejected as a safe drop-in change to the current pinned runtime: it is not publicly exposed by Sharp/libvips, decoded pixels change, representative image/metadata equivalence is unestablished, and the fixed-RGB diagnostic bridge lacks production lifecycle/platform coverage. This does not prove a supported upstream implementation cannot succeed. No speculative native runtime shim, effort downgrade, new production dependency or extra configuration switch is shipped.

| Final original combined trial | Peak cgroup MiB | Completed expected ops | Exit | New max / oom / oom_kill | Result |
| --- | ---: | ---: | ---: | --- | --- |
|1|512|4/8|137|120 / 1 / 1|FAIL|
|2|512|4/8|137|118 / 1 / 1|FAIL|
|3|512|4/8|137|130 / 1 / 1|FAIL|

Each trial used a fresh exact512-MiB/no-swap/network-none container, the original eight operations and unchanged24-MP fixture. Every measurement-mode file verifies the actual fixture SHA and records acceptance role, autoOrient=true, quality86, resize=false, no trace/worker/allocator overrides. Native admission peak remained1 before termination. Full DB/outbox/photo-integrity and application cleanup assertions were not reached after the OOMs and are NOT reported as passing. The host's cleanup=true means disposal of its owned test workspace, not successful application cleanup after SIGKILL. Post-run inventories are preserved without implementing the separate orphan-cleanup work.

Host-observed allocated temporary-disk peaks were36,642,816;36,638,720;37,134,336bytes for trials1/2/3. The codec experiment's retained raw RGB alone costs72,000,000bytes (68.66MiB); all generated payloads/evidence occupied100,856KiB at the final du snapshot. That snapshot is not a sampled peak or production disk improvement. The production pipeline is unchanged.

Earlier run38536976507 at e9f29cefd7db5cb0ee8bf054f939d830da72dfed also had three512-MiB/exit137 OOM failures (max136/116/177;oom2/1/2;one kill each;4/8 each), followed by a raw-output preparation failure. It is retained under initial-trials and initial-trials-job.txt; it is not substituted for the corrected final-source trials.

## Compatibility and next architecture

No changes to multipart ingress, admission ownership, abort/timeout/shutdown, photo IDs/URLs/keys/order/alt text, AI deterministic retries/finalization, transactions, outbox, backups or marketplace integrations. No new runtime configuration knobs or production dependencies. Existing regression coverage is rerun rather than adding implementation-mirroring runtime tests to unchanged services.

This probe is deliberately not a production native bridge: it supports only the exact RGB synthetic geometry and does not establish alpha, EXIF/ICC/CMYK/gray, animated/malformed inputs, interruption/ownership, cross-platform packaging or deterministic recipe migration. Quality=86 alone does not prove decoded equivalence. Any bitstream/pixel differences must be reviewed explicitly before selecting a runtime recipe.

The next narrow architectural experiment is an explicitly supported low_memory option through libvips and Sharp, retaining the existing pipeline instead of adding an HTTP-selectable codec child or raw-frame production staging. It needs pinned native build provenance, full image/metadata fidelity and lifecycle tests, then the unchanged full eight-operation gate in three fresh cgroups. Memory reduction predicted from token avoidance remains a hypothesis for the complete API until measured. If binding/recipe compatibility cannot be established, keep the feature disabled; do not silently substitute effort, quality, pixels, allocator flags or a larger host/threshold.

## Validation and rollback

Local:24 harness/fidelity tests pass (including exact limit/OOM/partial-output fail-closed policy and child timeout/abort/physical-close behavior);145 selected shared-admission/AI/product/Instagram integration tests pass; API typecheck and build pass. Linux tooling24tests pass. Native compilation uses -Wall -Wextra -Werror. CI #560 on the measured source runs all-workspace typechecks/tests/build/lint and real disposable PostgreSQL; final status and delivery-head CI are tracked in the Draft PR. The resource workflow intentionally reports failure for the three failed acceptance trials despite successful evidence preservation and codec diagnostics. A green software CI cannot override these results.

Rollback: close this feasibility Draft or revert its offline scripts/workflow changes. No production flags/settings, credentials, DB state or stored customer media are changed. Do not enable the parent upload feature based on codec-only results or green CI. Do not merge any dependency PR as part of this work.

## Evidence provenance

Initial runs 38536048323 and 38536467548 failed before fixture generation at the release configure/build bootstrap. Complete failure logs are retained beside this report. No resource results are inferred from those failures. The corrected CMake build uses the identical verified source archive.

### Retained artifacts

- [Final combined artifact11880159298](https://github.com/yali-code/noctella-web/actions/runs/38537514014/artifacts/11880159298), SHA256 `57a8133c05d0854e84b33fe755d17ba682adb59849a25d0393df694e2f5565dc`: complete contents committed in final-trials.
- [Complete codec artifact11880294390](https://github.com/yali-code/noctella-web/actions/runs/38537514014/artifacts/11880294390), SHA256 `46a509cb527b2d05b28dce6486cc6a485e9a4d7bfe5e2afcd0ca169c44965177`: complete 99,630,805-byte ZIP downloaded and preserved locally, including72-MB RGB and all WebP images. Compact raw text/JSON, build provenance and fidelity analysis are committed in codec. Generated binaries/images are kept out of Git; their SHA values and reproduction tools are retained. Actions expires2026-10-28, so long-term remote binary archiving remains an explicit limitation; the complete local archive is preserved.
- Initial three-trial artifact11880531858, SHA256 `28188440a9cdc7a05bf5744cd145988794f99fa6f55e3ab88e1b92dc813bf87b`, is committed in initial-trials. All build/preparation failures are retained rather than discarded.
- Full fixture provenance, cgroup samples/events, mode verification, operation progress, phase/RSS data and pre-disposal inventory remain raw evidence. The process RSS can exceed cgroup-charged memory because shared/file pages have different accounting; it is not substituted for cgroup.

### Remaining limitations and gates

The unchanged combined harness uses the real app/routes and synthetic SQLite, with local Instagram preparation/inspection rather than publishing. It does not reproduce a production HTTP listener, PostgreSQL pool, other concurrent API workloads or production baseline. PostgreSQL correctness is tested separately in CI; no database was contacted by the constrained containers. Passing isolated codec memory would not establish full API or production readiness. Representative JPEG/PNG/WebP, alpha/color/profile/orientation, animation/error/abort and retry fidelity remain required before any supported native-option implementation. The 384-MiB target and original recipe/workload stay fixed. Issue #390 remains unresolved.
