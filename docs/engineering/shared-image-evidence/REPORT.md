# P2-2B2A validation report — resource acceptance FAILED

[Draft #389](https://github.com/yali-code/noctella-web/pull/389), tracking #387 / parent #384. Stacked base is #386 at47b32ddd60348393597238c741400d48828f7c62. Runtime implementation973b66fbda6c065c01a85e2498cbea0e2acfef1b; reference profile revisiond09862c584eb00f5ad6efcd8724f00d56fc64436 changes tooling/evidence only.

The shared-admission foundation is implemented and regression-tested. **Full P2-2B2 resource acceptance is not achieved. Keep PRODUCT_PHOTO_DISK_STAGING_ENABLED disabled.** The smaller diagnostic result below cannot replace the failed24-MP workload.

## Primary near-limit24-MP workload: three failures

All three fresh containers enforced536870912-byte memory.max and0-byte memory.swap.max. Each was network-none/loopback-only, read-only-root, one CPU,128 PIDs, dropped capabilities and no-new-privileges. Node20.20.0, Sharp0.34.5/libvips8.17.3, observed Sharp concurrency1. Only seeded synthetic JPEG input and disposable SQLite/filesystem locations were mounted; no provider or customer data.

| Trial | Cgroup peak MiB | Exit | OOM kills | memory.max events | Completed operations | Native peak at last checkpoint | Observer RSS/HWM MiB | Work disk logical MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| linux-combined-t1 | 512.00 | 137 | 1 | 120 | 4/8 | 1 | 548.01 | 34.92 |
| linux-combined-t2 | 512.00 | 137 | 1 | 121 | 4/8 | 1 | 554.62 | 34.92 |
| linux-combined-t3 | 512.00 | 137 | 1 | 126 | 4/8 | 1 | 550.91 | 34.92 |

The unchanged384-MiB acceptance target failed; each case also hit the512-MiB hard limit. No timeouts or disk-stop events caused these exits. Baseline API-plus-probe RSS ranged153.65–157.46MiB. Exact cgroup peak/counters survived worker death via the keepalive container and external observer.

Every progress record completed product.setup, ai.upload.setup, instagram.prepare and product.upload.wave1. The second AI upload remained outstanding when the process died. Wave2/AI finalization and final row/source/application-cleanup assertions were **not reached**. NativePeak1 is a saved checkpoint measurement, not a final measurement after the OOM. In-process peak heap/external/ArrayBuffer values were lost; do not infer them from baseline.

Host cleanup successfully removed disposable case directories after stopping containers. This is NOT application crash recovery or proof that native partial files were cleaned by the killed worker. Process RSS/HWM and cgroup usage have different accounting; the cgroup limit/events are authoritative for acceptance.

These observations show that shared admission alone is insufficient for this workload. The outstanding original-size AI conversion and accumulated memory are profiling candidates, not an allocation-level causal diagnosis. No claim is made about historical production OOM causes. AI pixel/format rules were preserved rather than silently reduced to obtain passing results.

## Separate12-MP diagnostic: complete, not acceptance

A single additional reference uses pinned jpeg-typical-landscape (4032x3024 pixels), not the failed6000x4000 near-limit fixture. This scenario is tagged acceptanceRole=diagnostic-only in policy and raw evidence.

- Cgroup peak: 326.83MiB; worker RSS/HWM 353.66MiB; observer RSS/HWM 353.93MiB.
- Warm baseline RSS: 154.46MiB. Worker sampled heap/external/ArrayBuffer peaks: 44.63/23.26/15.06MiB.
- Eight of eight image-workflow operations completed; observed nativePeak=1 over24 native Promise calls. Both three-way phases ran actual product/AI HTTP plus local-only Instagram preparation/inspection.
- Four photo rows and promotion outbox events, deterministic AI photo ID/source hash, two retained private AI sources, nine canonical/derivative files and zero ingress/tmp leftovers passed assertions.
- Exit0, zero max/OOM/oom_kill deltas. Work disk 14.99MiB logical / 15.00MiB allocated. Batch4774ms includes setup/receive/queue/DB/processing, not pure Sharp time.

Clients run in-process and stream multipart files; integrity hashes stream. Heap sampling begins after API setup, while cgroup/OS process peaks include startup. Work disk includes SQLite, live canonical/AI files and can double-count transient hardlinks; it is not exclusively temporary staging. No production PostgreSQL, FFmpeg, provider calls, soak or adversarial load is included. A passing reference is not proof of24-MP safety or overall production readiness.

## Provenance and preserved evidence

| Role | Actions run | Artifact | Verified ZIP SHA256 |
| --- | --- | --- | --- |
| Primary24-MP acceptance, FAILED | [38439169032](https://github.com/yali-code/noctella-web/actions/runs/38439169032) |11833589757|ea1cb71a3e61bd3460b600b1253c6df9f9993468a618a0e97212c8a2e0113936|
| Smaller diagnostic, completed | [38440408381](https://github.com/yali-code/noctella-web/actions/runs/38440408381) |11835341120|e5b06e6290af17d9117064a0666d1b58ef300a3a3acbc426789741cc09efa3ec|

Raw summaries, fixture metadata and all failed progress/baseline records are committed alongside this report. Artifacts retain observer samples and logs14days; downloaded ZIPs/logs are preserved locally. The benchmark fixture source is pinned7c6ab55237e996fef041c60bb06f45b7d0fc2061 from #379, without merging it. The existing #383/#386 observer retains OOM evidence; thresholds were not relaxed. Failed cases remain failed.

## Verification and compatibility

-17 new lifecycle/inventory/real-workflow tests PASS. Actual delayed-native instrumentation observes maximum1 while product HTTP, deterministic AI finalization and Instagram run concurrently.
-363 scoped regressions across20 suites PASS: product/storage/outbox/backup, AI storage/finalization/routes/restart, Instagram preparation/approval/pending recovery/social/reel publishing (provider transports mocked).
- Additional real AI overload assertion PASS: capacity rejection precedes status lookup/ingress, while an already-finalized retry remains available with full capacity.
- API typecheck/build, explicit strict new-test typechecks and repository lint PASS; existing Admin img warnings remain. No new dependencies.
-11 harness-policy tests PASS, including the explicit separation of failed primary acceptance from the diagnostic reference.
- Runtime CI [#542](https://github.com/yali-code/noctella-web/actions/runs/38439094919) passed all repository tests, real disposable PostgreSQL tests, builds, typechecks and lint. Final stacked-head status is recorded in Draft #389; do not mistake ordinary CI for resource acceptance.
- Parent #386 remains at47b32ddd; its CI #540 remains successful. No parent-branch modification or duplicated parent changes in the stacked diff.

Buffer APIs, immutable image recipes, deterministic IDs/keys/retries, source retention, order/primary/alt, outbox and provider payloads are preserved. New behavior is gated. Enabled AI ingress is disk-backed before its full Buffer read. Instagram capacity pressure is retryable; flag-OFF legacy product/AI routes and actual storage/Instagram APIs still work even with a closed controller. See [coverage and compatibility design](../P2-2B2_SHARED_IMAGE_ADMISSION.md).

## Remaining work and rollback

Full B2 remains open. Before enablement, profile and resolve original-size AI image memory/cross-operation residency, review decoded-pixel policies, and repeat the unchanged failed workload. No smaller input, higher target or successful unit suite may substitute for that gate. Then require full mixed-workload repeated/soak/abort/shutdown/disk-pressure evidence.

FFmpeg, general provider/Admin content Buffers, DB/backup caches and other native memory are explicitly outside shared Sharp admission. Whole-album scopes can hit the60-second alarm and cause5-second waiting timeouts. Hard disk quotas and DB-aware orphan reconciliation remain separate tasks and were not implemented here.

Rollback: keep/unset the flag and restart; revert the stacked B2A change to B1 if needed. No schema/key migration. Preserve and reconcile canonical/private/ambiguous inventory under the existing operational plan; do not age-delete sources or canonical files. No merge, deploy, Render change, live database access, customer media, credentials change or real provider publishing occurred.
