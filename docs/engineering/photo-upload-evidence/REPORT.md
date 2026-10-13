# P2-2B1 resource and verification report

Draft [#386](https://github.com/yali-code/noctella-web/pull/386), Issue [#384](https://github.com/yali-code/noctella-web/issues/384). Runtime safety revision fa3adb600ebd2add451b9fd3f230be6140cda514; branch feat/photo-upload-bounded-memory-p2-2b1. The flag remains off by default. Full P2-2B and production acceptance remain open.

## Measured evidence and scope

All12 scenario definitions have a successful **versioned** result across three explicit revisions. This is not a full12-case run against final head. Final revision measured WebP c4 only; prior passing c1/c2/sequence/invalid cases were not restarted, and only failed c4 cases were rerun after the overload fix.

Selected outcomes: 45 successful uploads, 4 expected invalid/pixel rejections, 4 expected capacity rejections. Every selected case has zero memory.max/oom/oom_kill event deltas, exit0, exact512MiB memory.max, memory.swap.max0, loopback-only networking, matching DB/outbox/output counts and no private/temporary leftovers. Maximum cgroup peak 337.03MiB; maximum process RSS/HWM 361.95MiB. The384MiB target was not raised.

| Case | Runtime SHA | Cgroup MiB | Process RSS/HWM MiB | Heap MiB | External MiB | ArrayBuffer MiB | Work disk logical MiB | HTTP batch ms | HTTP statuses |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| linux-invalid | 75fb3de | 122.61 | 155.50 | 42.57 | 5.36 | 0.78 | 5.47 | 44 | 400 |
| linux-jpeg-c1 | 75fb3de | 226.69 | 247.71 | 43.92 | 17.89 | 13.30 | 16.55 | 3325 | 201/201/201/201 |
| linux-jpeg-c2 | 75fb3de | 235.37 | 256.86 | 43.47 | 23.73 | 19.14 | 25.77 | 3384 | 201/201/201/201 |
| linux-jpeg-c4 | ae41eea | 233.55 | 262.88 | 44.71 | 31.06 | 22.44 | 33.61 | 2118 | 503/201/201/201 |
| linux-png-c1 | 75fb3de | 260.11 | 278.04 | 44.58 | 22.26 | 17.67 | 18.79 | 3123 | 201/201/201/201 |
| linux-png-c2 | 75fb3de | 257.85 | 268.02 | 44.63 | 25.76 | 21.18 | 27.41 | 3136 | 201/201/201/201 |
| linux-png-c4 | ae41eea | 239.15 | 251.30 | 43.63 | 29.42 | 24.84 | 35.10 | 1809 | 503/201/201/201 |
| linux-sequential-12 | 75fb3de | 337.03 | 361.95 | 44.17 | 25.62 | 21.04 | 22.86 | 15988 | 201/201/201/201/201/201/201/201/201/201/201/201 |
| linux-stress-144mp-c4 | ae41eea | 137.60 | 165.09 | 44.96 | 13.76 | 9.18 | 10.96 | 185 | 503/400/400/400 |
| linux-webp-c1 | 75fb3de | 289.25 | 318.04 | 43.30 | 20.25 | 15.66 | 17.25 | 9920 | 201/201/201/201 |
| linux-webp-c2 | 75fb3de | 287.45 | 315.89 | 43.53 | 20.99 | 16.40 | 26.02 | 9843 | 201/201/201/201 |
| linux-webp-c4 | fa3adb6 | 290.84 | 321.75 | 43.43 | 29.50 | 24.92 | 34.20 | 4254 | 503/201/201/201 |

Warm API-plus-probe baseline RSS ranged 152.19–157.20MiB. Work disk high-water was 35.10MiB logical / 35.10MiB allocated. These include SQLite/canonical outputs and can double-count transient hardlinks; they are not a measurement exclusively of staging. Heap/external/ArrayBuffer samples begin at warm baseline, while cgroup peak and OS process high-water cover startup. Batch times include receive, queue, transforms and DB; they are not pure Sharp timing.

Ubuntu24.04 GitHub runner, Node20.20.0, Sharp0.34.5/libvips8.17.3, one container CPU and Sharp concurrency1 as observed. Containers have512MiB enforced/no swap, network none, read-only root, dropped capabilities, no-new-privileges and128 PIDs. Full app routes are loaded, SQLite/auth/category/product are synthetic, and multipart clients stream local fixture files in the same cgroup. index.ts schedulers and production PostgreSQL/traffic are not started. Generator is separate2GiB/no-network; generation is excluded from the measured cgroups.

## Provenance and failures retained

| Source | Actions run | Artifact | ZIP SHA256 |
| --- | --- | --- | --- |
| Intermediate buffered-stream5d37f87, FAIL | [38425661511](https://github.com/yali-code/noctella-web/actions/runs/38425661511) |11828019581|5c9b13f982d70b995ee8fa7ad4d1edd8b10450b8bce569dbdbcb4486a0a3f2fe|
| Native75fb3de,8 pass/4 fail | [38426951715](https://github.com/yali-code/noctella-web/actions/runs/38426951715) |11829296963|6da4936d41c024a3e8037ee22e99984a54de24508011d9ce2cf9a5c0cfb6e08f|
| c4-only ae41eea,3 pass/1 fail | [38428694945](https://github.com/yali-code/noctella-web/actions/runs/38428694945) |11829967653|e0b849dc33711c9c441a28c5e7e3b78ed269e4c712a45e80c301363adc89ee6d|
| WebP-only fa3adb6, PASS | [38430085616](https://github.com/yali-code/noctella-web/actions/runs/38430085616) |11829629643|b4393aa7ec138741e883a424c9ecec7795e76885beb26b031602ec69a550426b|

All four raw summary JSON files are committed alongside this report, including failed cases. Artifacts contain observer samples, worker logs, preflight and host snapshots, retained14days. ZIP hashes were verified locally before extraction. P2-1 synthetic fixture source is pinned7c6ab55237e996fef041c60bb06f45b7d0fc2061 without merging #379; observer/policy ported from #383/44ae46b, not modified there. Initial image build/setup failures generated no measured acceptance cases.

## Executed verification

- Final scoped regression command:15 suites,259 tests PASS (product photos, outbox workflow/stale locks/scheduler/restart, backup/recovery, AI-intake photo storage/content/finalization/routes/restart and three new test files).
- New tests:34 PASS, including exact10MiB/+1, partial/slow/malformed multipart, excess raw epilogue, queue/abort/native permit lifetime, overload with near-limit body, input/output ENOSPC, output size, cleanup/orphans, EXDEV/collision, alpha/EXIF/recipe parity and committed-then-error ownership.
- API typecheck and explicit strict typecheck of all three new test files PASS.
- API build PASS; repository lint PASS with existing Admin img warnings. No API-specific lint script exists.
- Nine isolated resource-policy tests PASS, including enforcement failure, OOM/exit/cleanup/target gates and bounded full/c4/WebP-only profiles.
- Full CI #537 passed native file-output revision, including repository tests, real disposable PostgreSQL tests, all typechecks/builds/lint. Final runtime CI [#539](https://github.com/yali-code/noctella-web/actions/runs/38430044788) and final documentation-head CI status are recorded in the Draft PR delivery report; do not infer head acceptance from an earlier green run.
- Reference #383 final-head CI #532 was checked and passed before acceptance claims. Original and reference worktrees were read-only checked clean; no branch/PR was changed there.

## Disk model and limitations

Legacy ingress creates a complete input Buffer per concurrent request, and its output path creates full main/thumb Buffers. Candidate uses private file input and Sharp native file output; it does not call readFile/toBuffer for those bytes. Analytical private reservation42MiB/request (10MiB +2x16MiB),126MiB for three admissions inside128MiB software inventory budget. Outputs are size-checked **after** native encoding; transient overshoot is possible. This is not a filesystem quota, a bound on all other API activities, or a measured production improvement.

Baseline and native memory depend on runner/library/cache/allocator behavior. P2-1 Windows figures and #383 transform-only figures cannot be treated as production baselines or direct before/after API comparisons. Historical production OOM cause is not established by these synthetic tests.

## Remaining gates and rollback

Product-only admission still excludes AI-intake and Instagram Sharp callers. Before enablement: shared admission without nested deterministic-finalization deadlock; representative pixel/format corpus; hard temporary quota/free-space and DB-aware crash/canonical recovery; full final-head12 cases at least three trials;30-minute soak; external-client adversarial/abort/overload tests; combined AI/outbox/backup/background workloads; reviewed limits and operational enablement. The512MiB hard limit and384MiB target remain binding. No production-readiness claim.

Candidate DB transaction errors retain canonical files and close admission because lost commit acknowledgement cannot prove rollback. Stage cleanup after confirmed persistence preserves201 and referenced media. Unreferenced/ambiguous pairs require reconciliation, not age deletion or automatic retries. Legacy response-read compensation is fixed, but its ambiguous-network-commit behavior remains a follow-on.

Rollback: keep/unset PRODUCT_PHOTO_DISK_STAGING_ENABLED and restart. No schema/key migration. Drain/preserve/reconcile private and ambiguous inventory; existing canonical media and outbox remain compatible. No merge/deploy/production access occurred. See [architecture and acceptance matrix](../P2-2B1_PHOTO_UPLOAD.md).
