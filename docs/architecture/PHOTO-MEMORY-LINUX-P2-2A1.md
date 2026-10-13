# P2-2A.1: isolated Linux 512-MiB photo-processing harness

Tracking: #382. References: Draft #379 (P2-1), Draft #381 (P2-2A), #377.
Status: isolated tooling only. Hosted execution/results are recorded below when available.
No production image processing, multipart route, DB, infrastructure setting or provider code changes.

## Existing CI and hosted-runner feasibility

Normal .github/workflows/ci.yml runs on PRs to main and main pushes, Ubuntu/Node20,
workspace tests/build/lint and a disposable PostgreSQL service. It does not enforce512MiB
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

A separate checkout reads exactly #379 head7c6ab55237e996fef041c60bb06f45b7d0fc2061.
The image copies only five P2-1 modules and unmodified photoStorage.ts/errors.ts, not the
checkout's Git metadata, environment or data directories. It imports P2-1 fixture generation
and runScenario directly. No merge/cherry-pick or modification of #379/#381 branches occurs.
The Docker image pins Node20.20.0, Sharp0.34.5, tsx4.21.0 with an independent lockfile.
Record image ID, source SHA-256, actual Node/Sharp/libvips and CPU/OS. Node20 aligns with
existing CI major version but differs from Windows P2-1's Node24.18.0; compare cautiously.
No dependencies from Windows node_modules are mounted into Linux.

Image dependency installation may access public registries before measurement. Every fixture
generation and measurement container uses network=none, no credentials, no socket mounts,
cap-drop ALL, no-new-privileges, read-only image root and numeric nonroot user. Only synthetic
fixtures (read-only for measurements), disposable work and evidence directories are mounted.
No production directory or writable repository mount is given to the container.

## Resource and workload bounds

- Measurement containers: memory512MiB; memory-swap512MiB (total memory+swap => zero swap);
  1 CPU; pids-limit128. Verify INSIDE each container memory.max=536870912 and
  memory.swap.max=0 and only loopback interfaces; also inspect Docker's network/read-only config.
- Fresh keepalive container per scenario, one scenario at a time. PID1 sleep remains while
  docker exec runs the worker, retaining cgroup counters even if the large worker is OOM-killed.
  If the whole container dies and final cgroup evidence is unavailable, mark INCONCLUSIVE.
- Proposed acceptance target: cgroup memory.peak<=402653184 (384MiB), no new max/oom/oom_kill
  events, successful expected outcomes, valid file counts and cleanup. Any stress failure
  remains a failed job, even when artifact preservation succeeds.
- Nine near-limit cases: JPEG/PNG/WebP, concurrency1/2/4, four operations each; twelve
  sequential mixed operations; invalid random input; optional last144MP/c4 stress.
  12 cases /53 operations with stress, 11 cases /49 without. No35-scenario full run.
- Five fixture types from corrected #379 specs. Generate once outside measured cgroups in a
  network-disabled 2-GiB/2-CPU container (<=7minutes). This is fixture preparation, NOT accepted
  512-MiB workload evidence. Input dimensions/encoded bytes/hashes are retained as metadata.
- <=120s per case; <=20min measurement step; <=8min image build and fixture steps;
  <=45min entire hosted job. One queued/running workflow group; no automatic repeat per push.
- Sample disk allocated/payload bytes every50ms; stop if disposable work exceeds256MiB.
  This is a sampled stop threshold, not a filesystem hard quota. Small fixed operation counts
  and output dimensions also bound the workload. Actual disk usage is reported, not inferred.
- At most2000 samples/case written; worker log tail<=64KiB; evidence payload checked<=16MiB.
  Artifact retention14days. No synthetic image bytes or customer data are uploaded; metadata,
  raw numeric metrics, source digests, versions and isolated errors only.

## Evidence and failure semantics

P2-1 worker reports process resourceUsage maxRSS and5ms sampled heap/external/ArrayBuffer,
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
Tests cover profile bounds, missing/unlimited/swap/network enforcement, event parsing,384MiB
boundary, OOM/nonzero exits, time/disk/cleanup failures, lost/reset counters, lost worker
result, unexpected outcomes and process RSS units. Node syntax and workflow YAML parse checks
also pass. Local Docker/WSL remain unavailable: no local constrained measurements claimed.

Hosted run: pending explicit opt-in execution. Actual measurements and CI status will be
recorded in this document/evidence before delivery. Do not interpret the test fakes as Linux data.

## Interpretation and next acceptance gates

This exercises the UNMODIFIED canonical photo pipeline accepting Buffer input; it does not
implement disk multipart staging,24MP admission, finite request queue or backpressure.
A transform-only PASS under384MiB is not production acceptance. A FAIL documents baseline
risk, not a license to raise the acceptance target or silently skip stress.

Next, separately authorize P2-2B after review: validate representative-photo pixel policy;
measure a warmed full Express/API baseline with disposable DB and synthetic authenticated
multipart traffic; account for staging page cache, input streams/socket buffering, shared
AI-intake/Instagram Sharp activity, outbox, quotas, abort/ENOSPC/crash cleanup and commit
ownership. Evaluate one versus two admitted jobs under the same512MiB/384MiB gates.
Need repeated trials and soak before capacity claims. Historical production OOM cause remains
unproven. No Render, live DB, S3, customer media or marketplace calls are part of this work.

Rollback removes/reverts this offline workflow/scripts/docs; no schema/config/data reversal.
Do not merge, deploy or begin P2-2B based solely on this harness.
