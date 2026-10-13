# P2-2B2B: staged AI input and native-memory investigation — BLOCKED

Tracking [#390](https://github.com/yali-code/noctella-web/issues/390), stacked on [#389](https://github.com/yali-code/noctella-web/pull/389) at c76d00f47803e3218e39270ab860d3f8b5b08ab6. This is a partial, disabled-by-default engineering deliverable, **not an OOM fix or production-readiness claim**. No tested adaptation has met the unchanged 384-MiB gate.

## Narrow implementation

Enabled AI HTTP ingress now passes the private, server-owned staged path directly to Sharp. It no longer reads the complete multipart input into a JavaScript Buffer. Storage validates containment, basename, regular/non-symlink identity, realpath and exact byte size under shared admission before processing. It uses the existing failOn:error, auto-orientation, full original resolution and quality-86 WebP conversion, with exclusively owned output and post-native abort cleanup. File caching is disabled for this disk capability because cached handles prevented Windows cleanup in regression testing; this matches the existing gated product policy.

The established Buffer storage/service APIs remain supported. Both upload entry points share the same intake Open precheck, locked insert and newly-written-file compensation on insert failure. No transaction/ID/key/schema/outbox/publishing recipe changes. No canonical or retained AI source deletion is added. Temporary ingress remains owned and cleaned by the existing B1 handler, after native settlement.

The experiment disabling the entire native operation cache failed and was reverted. The final implementation retains only the smaller staged-input capability and file-handle policy; it does not globally remove all native caching.

## Reproducible environment and evidence

Each case uses a fresh Docker cgroup on GitHub Ubuntu24.04, Node20.20.0, Sharp0.34.5/libvips8.17.3, observed Sharp concurrency1. Verified memory.max=536870912 and memory.swap.max=0, network none/loopback only, readonly root, CPU1, pids128, dropped capabilities and no-new-privileges. Synthetic SQLite/authenticated API requests and local Instagram helper only; no provider, customer media, production database or Render access.

The unchanged 6000x4000 JPEG is 9,670,997 bytes, SHA256 2f2f90eb7060b031815c5afc8503e2914b2e7eb398b29eabfd23330443c441c7. The pinned P2-1 generator is 7c6ab55237e996fef041c60bb06f45b7d0fc2061; fixture generation runs outside measured cgroups. All profiles below use exactly the original combined eight-operation workload. No input, resolution, quality, threshold, swap or workload reduction.

| Revision / role | Run | Peaks MiB (trials1/2/3) | Exit | OOM kills/trial | Completed operations |
| --- | --- | --- | --- | --- | --- |
| e869727: parent runtime + phase traces | [38444926727](https://github.com/yali-code/noctella-web/actions/runs/38444926727) |512/512/512|137/137/137|1/1/1|3/8,4/8,4/8|
| 8885c54: staged-path candidate | [38445683697](https://github.com/yali-code/noctella-web/actions/runs/38445683697) |512/512/512|137/137/137|1/1/1|3/8,4/8,4/8|
| efd520f: staged-path + no-cache experiment (reverted) | [38446511038](https://github.com/yali-code/noctella-web/actions/runs/38446511038) |512/512/512|137/137/137|1/1/1|3/8,4/8,4/8|

New memory.max events: baseline203/187/168; staged158/112/114; no-cache145/123/124. Zero timeout/disk-stop events. Final-revision trials are recorded below. **Any failed trial means resource acceptance BLOCKED.** CI success is independent.

Raw preflight, baselines, phase traces, observer samples, events, progress, host summaries, worker logs and fixture metadata are preserved in the three adjacent evidence directories. Artifact ZIP hashes were verified locally:

- baseline artifact11837933353: fd5e46fd2232346dffcd7203669f96494f06cfb0a96e96b1f557a70fe03c4609
- staged artifact11837099628: cccae59efb42a26bccc3288f829a8a5157a84bee294617feddbc1def45752321
- no-cache artifact11838148288: 04998cf59daceabe4283d65d0d45d22e18438be8dca9252cdb6ad7c024a2c558

ZIPs and local validation logs are preserved outside Git; complete expanded synthetic evidence is committed to avoid the 14-day Actions artifact expiry. Git line-ending normalization may change expanded text hashes; ZIP digests identify the original archives.

## Measured contributors and limits of diagnosis

Offline-only tracing wraps native metadata/toFile/toBuffer and fs-promises readFile, saving process RSS/heap/external/ArrayBuffers, cgroup current/peak/events/stat, native cache stats and workflow boundaries synchronously. The external host observer continues through worker OOM. Instrumentation introduces some overhead/scheduling perturbation: these runs sometimes complete three operations rather than the parent's four. Never infer a missing response completed.

Baseline full AI ingress reads allocate the 9.22-MiB encoded input. Before the failing second native encoder, JS heap was42.43–43.08MiB and external memory13.92–16.42MiB in the saved metadata/start traces; cgroup current282.27–307.68MiB. The corresponding anonymous cgroup memory was255.26–269.37MiB. This is observed residency, not a heap leak diagnosis.

The staged candidate eliminates those ingress readFile calls. Its second AI toFile starts with external memory5.70–9.06MiB and cgroup current261.63–274.62MiB. Cross-run differences are not a controlled allocator-level attribution, but the eliminated full-input Buffer is directly supported by code and traces. Capped peak stays512MiB, so there is **no measured peak improvement or accepted OOM fix**.

In all variants, the last native start is the second full-resolution AI toFile. No native end is saved before OOM. In the no-cache experiment, current/max memory cache and cached-item counts are zero at that start, yet all three workers die. Full native operation caching is therefore not a sufficient explanation/remedy. Shared nativePeak1 at saved checkpoints supports serialization; it is not a final measurement after death.

The [libvips8.17.3 WebP saver source](https://raw.githubusercontent.com/libvips/libvips/v8.17.3/libvips/foreign/webpsave.c) uses full-frame pixel storage and a WebP memory writer even for file destinations. This explains why disk output is not intrinsically bounded native encoding. It does not quantify the individual frame, codec, decoder or allocator contributions in these runs; no allocator-specific root cause is claimed. RSS and cgroup accounting differ; cgroup peaks/events are authoritative.

Finalization still uses its existing staged Buffer reader and deterministic derivative outputs. It was inspected but is not reached in the failed near-limit runs; changing it cannot be presented as resolving this earlier kill. Admin/provider content Buffer APIs remain unchanged. Peak heap/external/ArrayBuffer values after OOM are unavailable; phase checkpoints are not final peaks. Sampled RSS/HWM can exceed cgroup usage because of accounting/shared mappings, not a bypass of enforcement.

Work disk peaks are about34.46–34.92MiB and include retained sources, SQLite, canonical/derivative files and transient links, not just staging. Host cleanup succeeded, but does not prove killed-process application cleanup, crash recovery or reconciliation. No exact allocator cause or historical production OOM attribution is established.

## Regression and compatibility validation

Ten new deterministic tests cover JPEG/PNG/WebP byte-for-byte output fidelity against the old Buffer recipe, orientation/full dimensions, source retention, invalid/unsafe/mismatched input, Linux symlink rejection, pre-abort, mid-native abort/drain, owned partial cleanup, disk failure, cleanup failure, queue timeout/cancellation, shutdown and flag-OFF legacy Buffer operation. Windows symlink creation is unavailable; Linux CI executes that assertion.

Existing shared-admission, actual product/AI HTTP + deterministic finalization/Instagram, retry/ID/key/source integrity, transaction compensation, outbox, backup, Instagram preparation/publishing recovery (mocked transports) tests run. Local expanded suite:383 tests across22 suites passed on the no-cache diagnostic; final narrow policy rerun/CI recorded in the Draft. Strict new-test typing and harness policy11 tests pass. API typecheck/build and repository lint pass (existing Admin image warnings). Full CI/PostgreSQL results are recorded in the Draft after final-head validation.

Feature remains PRODUCT_PHOTO_DISK_STAGING_ENABLED=false/unset by default. No enablement or hot-toggle support; restart for policy changes. HTTP contracts, original filenames/server actor, AI resolution, WebP quality, deterministic IDs/keys/retries/source retention and product ordering/alt/outbox/provider payloads remain.

## Remaining technical blocker and next steps

The safe input-residency optimization does not solve full-resolution native AI encoding within the budget. Further work must quantify native allocations during the single conversion and validate a recipe-compatible way to reduce its transient footprint/residency before enablement. Native allocator/codec profiling and an isolated conversion worker are candidates to evaluate, not proven fixes. A worker's memory must be included in the same cgroup; moving it outside measured limits would be invalid. Lower effort, quality, dimensions, smaller fixtures or larger memory targets are not accepted substitutions.

Only after a new implementation passes all three original combined trials (<=384MiB, no max/OOM events,8/8 operations and every DB/outbox/integrity/cleanup assertion) should mixed-load soak and interruption acceptance proceed. #390 remains open. Hard quotas/orphan recovery/production operations remain outside this PR.

Rollback: leave/unset the flag and restart; revert this stacked change to #389 if necessary. No schema/key migration. Preserve retained/canonical inventory and reconcile ambiguous committed results using existing procedures; do not blindly retry or delete files after a worker kill.

## Final implementation resource gate

**BLOCKED.** Final implementation eeab65740cd359e6be85b56c91a68497c2f65cd3, [run38447620135](https://github.com/yali-code/noctella-web/actions/runs/38447620135), repeats the original fixture/workload in three fresh verified512-MiB/no-swap cgroups.

| Trial | Cgroup peak MiB | Exit | New max/oom/oom_kill events | Completed | Final DB/outbox/integrity/cleanup assertions |
| --- | --- | --- | --- | --- | --- |
|1|512|137|158/1/1|3/8|Not reached|
|2|512|137|112/1/1|4/8|Not reached|
|3|512|137|125/1/1|4/8|Not reached|

All last saved nativePeak values are1; the second AI encoder is outstanding. Observer sampled RSS/HWM:551.59/551.91/553.06MiB; these have different accounting from cgroup memory. Disk logical peaks:36,132,101/36,616,451/36,616,451 bytes. Final heap/external/ArrayBuffer peaks are unavailable because of OOM.

Artifact11839146822 SHA2568045f6d7281b18c5de85797bfceb1ae3a058b5194ff6765f12058698051c9a45 verified locally. Complete raw evidence is in final-eeab657. Subsequent delivery commits change only documentation/evidence, with the measured API source unchanged. Resource acceptance has not improved: original and final peaks are capped at512MiB; the384-MiB target remains unmet in every trial.
