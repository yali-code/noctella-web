# P2-2A.1: isolated Linux 512-MiB photo-processing harness

Tracking: #382. References: Draft #379 (P2-1), Draft #381 (P2-2A), #377.
Status: hosted enforced-limit run completed; baseline stress exceeds proposed acceptance target.
No production image processing, multipart route, DB, infrastructure setting or provider code changes.

## Existing CI and hosted-runner feasibility

Normal .github/workflows/ci.yml runs on PRs to main and main pushes, Ubuntu/Node 20,
workspace tests/build/lint and a disposable PostgreSQL service. It does not enforce 512 MiB
or measure the full API's memory. It is unchanged by this PR.

GitHub-hosted Ubuntu supplies an isolated VM with Docker capability; feasibility here still
requires actual runtime verification. [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
documents the Linux runner/sudo model. [Docker memory controls](https://docs.docker.com/engine/containers/resource_constraints/)
support hard memory and swap limits. The harness fails inconclusively if cgroup v2 exact values,
memory.peak or events cannot be read. No unlimited fallback exists.

The dedicated workflow has fast policy tests on relevant PR changes. Expensive measurement
has NO push, schedule, synchronize or ordinary PR-open trigger. Use workflow_dispatch when
available. [GitHub's event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
requires the workflow on the default branch for normal initial dispatch availability; no merge
is authorized here. For pre-merge validation, explicitly EDIT this same-repository Draft PR's
title to start with [run-photo-512m]. Only an edited event with a changed title and that prefix
runs the benchmark. Body edits/pushes do not repeat it; remove/re-add prefix for another run.
No pull_request_target, secrets or write-token checkout. permissions is contents:read and
checkout persist-credentials:false. This narrowly scoped manual bootstrap is deliberate.

## Reuse and pinned provenance

A separate checkout reads exactly #379 head 7c6ab55237e996fef041c60bb06f45b7d0fc2061.
The image copies only five P2-1 modules and unmodified photoStorage.ts/errors.ts, not the
checkout's Git metadata, environment or data directories. It imports P2-1 fixture generation
and runScenario directly. No merge/cherry-pick or modification of #379/#381 branches occurs.
The Docker image pins Node 20.20.0, Sharp 0.34.5, tsx 4.21.0 with an independent lockfile.
Record image ID, source SHA-256, actual Node/Sharp/libvips and CPU/OS. Node 20 aligns with
existing CI major version but differs from Windows P2-1's Node 24.18.0; compare cautiously.
No dependencies from Windows node_modules are mounted into Linux.

Image dependency installation may access public registries before measurement. Every fixture
generation and measurement container uses network=none, no credentials, no socket mounts,
cap-drop ALL, no-new-privileges, read-only image root and numeric nonroot user. Only synthetic
fixtures (read-only for measurements), disposable work and evidence directories are mounted.
No production directory or writable repository mount is given to the container.

## Resource and workload bounds

- Measurement containers: memory512 MiB; memory-swap512 MiB (total memory+swap => zero swap);
  1 CPU; pids-limit128. Verify INSIDE each container memory.max=536870912 and
  memory.swap.max=0 and only loopback interfaces; also inspect Docker's network/read-only config.
- Fresh keepalive container per scenario, one scenario at a time. PID1 sleep remains while
  docker exec runs the worker, retaining cgroup counters even if the large worker is OOM-killed.
  If the whole container dies and final cgroup evidence is unavailable, mark INCONCLUSIVE.
- Proposed acceptance target: cgroup memory.peak<=402653184 (384 MiB), no new max/oom/oom_kill
  events, successful expected outcomes, valid file counts and cleanup. Any stress failure
  remains a failed job, even when artifact preservation succeeds.
- Nine near-limit cases: JPEG/PNG/WebP, concurrency 1/2/4, four operations each; twelve
  sequential mixed operations; invalid random input; optional last 144 MP/c4 stress.
  12 cases /53 operations with stress, 11 cases /49 without. No 35-scenario full run.
- Five fixture types from corrected #379 specs. Generate once outside measured cgroups in a
  network-disabled 2-GiB/2-CPU container (<=7 minutes). This is fixture preparation, NOT accepted
  512-MiB workload evidence. Input dimensions/encoded bytes/hashes are retained as metadata.
- <=120s per case; <=20min measurement step; <=8min image build and fixture steps;
  <=45min entire hosted job. One queued/running workflow group; no automatic repeat per push.
- Sample disk allocated/payload bytes every 50 ms; stop if disposable work exceeds256 MiB.
  This is a sampled stop threshold, not a filesystem hard quota. Small fixed operation counts
  and output dimensions also bound the workload. Actual disk usage is reported, not inferred.
- At most2000 samples/case written; worker log tail<=64KiB; evidence payload checked<=16 MiB.
  Artifact retention14 days. No synthetic image bytes or customer data are uploaded; metadata,
  raw numeric metrics, source digests, versions and isolated errors only.

## Evidence and failure semantics

P2-1 worker reports process resourceUsage maxRSS and5 ms sampled heap/external/ArrayBuffer,
latency, main/thumb bytes and expected outcomes. Runner-host Node is NOT the workload RSS.
An observer outside the measured cgroup samples its memory.current/peak/events, host /proc
VmRSS/VmHWM for container processes and disposable disk usage. These samples add no process
to the measured cgroup. RSS/HWM observed before an OOM is a lower bound if worker JSON is lost.
Do not sum external and ArrayBuffer peaks; ArrayBuffer is included within external.

Before and after snapshots retain exact limits, kernel cgroup peak and event deltas. This
follows [cgroup v2 accounting](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html);
peak includes the cgroup's processes, native allocations and charged cache, not just JS heap.
Docker inspect retains state/exit/OOMKilled separately from docker exec exit. Container PID1
exit and worker exit are distinct. Startup/import/preflight/keepalive cost is included in
cgroup lifetime peak. Generated input cache may be warm/reparented from preparation, so this
does not establish cold-cache whole-service behaviour.

Each case writes preflight, raw worker result if available, host evidence and samples to
host-owned evidence files. Summary checkpoints after EVERY completed case. On a step timeout,
an always-run recovery step saves inspect/cgroup files for any remaining harness containers,
then stops only those disposable containers. Artifact upload is always-run; final step checks
measurement outcome and cannot convert a failed/OOM run into green. Runner cancellation/VM
loss or outer job timeout may still prevent artifact upload; no promise of evidence survival
under host destruction. Inner deadlines leave headroom for recovery/upload.

After measurement snapshot, only that generated case directory is removed with parent/name
containment checks. Canonical file bytes here are synthetic outputs in /work/photos. No real
photo store is mounted. Cleanup success is part of assessment; retained JSON/logs are evidence,
not disposable file leaks. Source registry/build or cgroup failure is INCONCLUSIVE, never PASS.

## Local tests and execution evidence

Local Windows: node --test scripts/photo-memory-linux/policy.test.mjs:8/8 passed.
Tests cover profile bounds, missing/unlimited/swap/network enforcement, event parsing,384 MiB
boundary, OOM/nonzero exits, time/disk/cleanup failures, lost/reset counters, lost worker
result, unexpected outcomes and process RSS units. Node syntax and workflow YAML parse checks
also pass. Local Docker/WSL remain unavailable: no local constrained measurements claimed.

## Hosted execution evidence — completed, target NOT fully satisfied

[Measurement run #2](https://github.com/yali-code/noctella-web/actions/runs/38415117596),
benchmark job 115357491350, harness commit 1dd28bea1221d4d7f8f245419f13c85fc44697cd.
Measurements ran October 13, 2026 **17:40:44–17:41:46 Europe/Istanbul** (raw timestamps UTC).
Ubuntu 24.04.5, kernel 6.17.0-1022-azure, AMD EPYC 9V74 host (4 logical CPUs), Docker 28.0.4;
each workload container had **1 CPU**, Node 20.20.0, Sharp 0.34.5/libvips 8.17.3 and
actual Sharp concurrency 1. The image ID and full versions are in raw evidence.

All 12 containers passed inside-container verification of memory.max=536870912,
memory.swap.max=0 and loopback-only interfaces; Docker inspection confirmed network=none,
read-only root and safe disposable mounts. **53 operations completed: 52 valid transforms
and one expected invalid-input rejection. All worker exits were 0, no timeout, no new max,
oom, oom_kill or oom_group_kill events; all case directories were removed.**

| Scenario | Assessment | Cgroup peak MiB | Process peak RSS MiB | Peak allocated work disk MiB | Worker exit | Workload ms |
|---|---|---:|---:|---:|---:|---:|
| linux-jpeg-c1 | PASS | 164.4 | 201.9 | 1.96 | 0 | 2132 |
| linux-jpeg-c2 | PASS | 245.7 | 282.4 | 1.96 | 0 | 2182 |
| linux-jpeg-c4 | PASS | 300.1 | 336.7 | 1.96 | 0 | 2880 |
| linux-png-c1 | PASS | 214.4 | 248.7 | 3.85 | 0 | 1886 |
| linux-png-c2 | PASS | 264.9 | 301.4 | 3.85 | 0 | 1919 |
| linux-png-c4 | PASS | 304.0 | 341.1 | 3.85 | 0 | 2491 |
| linux-webp-c1 | PASS | 250.5 | 286.4 | 2.51 | 0 | 7117 |
| linux-webp-c2 | PASS | 324.7 | 360.6 | 2.51 | 0 | 7591 |
| linux-webp-c4 | PASS | 322.8 | 361.1 | 2.51 | 0 | 8609 |
| linux-sequential-12 | PASS | 312.2 | 343.4 | 8.15 | 0 | 11158 |
| linux-invalid | PASS | 48.7 | 87.4 | 0.09 | 0 | 2 |
| linux-stress-144mp-c4 | FAIL | 389.6 | 428.0 | 0.13 | 0 | 3027 |

**11 cases passed; the 144-MP/c4 stress case failed the proposed 384-MiB target** at
408,535,040 bytes /389.6 MiB cgroup peak (448,749,568 bytes /428.0 MiB process RSS).
It stayed below the 512-MiB enforced hard limit and had **no OOM**. The workflow conclusion
is deliberately FAILURE, not a harness crash: its evidence uploader succeeded, and the final
gate preserved the failed target assessment. Do not rerun/skip this case to make it green.

Maximum sampled heap 8.72 MiB, external 101.79 MiB, ArrayBuffer 95.64 MiB across cases; they are
separate peaks and not additive. Maximum sampled allocated work disk 8,544,256 bytes /8.15 MiB
occurred during sequential 12. This includes generated outputs/config/tsx cache and is not
total host/image/fixture disk. Existing pre-scenario tmp cache was excluded from P2-1's
unexpected-leftover check but included in host disk accounting; final disposable root was removed.

Cgroup and process RSS are intentionally separate measures. RSS can include shared mapped
pages with different cgroup charge ownership, so it need not be below this cgroup's usage.
The observer's kernel VmRSS/VmHWM readings corroborate the worker's process-level scope;
exact attribution of shared-page differences is not profiled. Neither metric is host Node RSS.
These single trials do not establish repeatability or full API headroom.

Permanent reviewed evidence:
[raw summary](evidence/p2-2a1/run-38415117596/summary.json),
[synthetic fixture manifest](evidence/p2-2a1/run-38415117596/fixtures.json),
[source digests](evidence/p2-2a1/run-38415117596/source-sha256.txt),
[Docker environment](evidence/p2-2a1/run-38415117596/docker-info.txt),
[artifact receipt](evidence/p2-2a1/run-38415117596/receipt.json).

The complete 64-file artifact (per-case worker/preflight/host evidence and observer samples)
is [available on the run](https://github.com/yali-code/noctella-web/actions/runs/38415117596/artifacts/11823432542).
ZIP 75,502 bytes, SHA-256 a339e1e26654026f5c55e7ec958ea5b37431ad0d40adccb35e11f01ab8c9b88c,
verified after download; GitHub retention expires October 27, 2026. Full extraction/ZIP also
retained locally in ignored p2-2a1-evidence.local. The durable summary is committed so core
measurements survive artifact expiry. An actual OOM-kill did not occur in this workload:
OOM evidence survival has policy/failure-path tests, but is not claimed empirically demonstrated.

Tooling tests passed 8/8 on Windows and GitHub Ubuntu. The ordinary PR-open run skipped the
benchmark as designed. Regular CI is tracked separately from this correctly failed resource gate;
its final status is reported in the Draft PR/final delivery. No claims of passing constrained
production/full-API acceptance or historical production OOM causation follow from these results.


## Interpretation and next acceptance gates

This exercises the UNMODIFIED canonical photo pipeline accepting Buffer input; it does not
implement disk multipart staging,24 MP admission, finite request queue or backpressure.
A transform-only PASS under 384 MiB is not production acceptance. A FAIL documents baseline
risk, not a license to raise the acceptance target or silently skip stress.

Next, separately authorize P2-2B after review: validate representative-photo pixel policy;
measure a warmed full Express/API baseline with disposable DB and synthetic authenticated
multipart traffic; account for staging page cache, input streams/socket buffering, shared
AI-intake/Instagram Sharp activity, outbox, quotas, abort/ENOSPC/crash cleanup and commit
ownership. Evaluate one versus two admitted jobs under the same512 MiB/384 MiB gates.
Need repeated trials and soak before capacity claims. Historical production OOM cause remains
unproven. No Render, live DB, S3, customer media or marketplace calls are part of this work.

Rollback removes/reverts this offline workflow/scripts/docs; no schema/config/data reversal.
Do not merge, deploy or begin P2-2B based solely on this harness.
