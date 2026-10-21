# Photo engineering local handoff — 21 October 2026

## Current boundary and branch

**F2 CLOSED, 4/4; overall engineering 5/12.** Source: [release package §7.1](../release/F2_CLOSURE_STAGE1_RELEASE_PACKAGE.md#71-stage-4-production-verification-enablement-and-acceptance-20-october-2026). Production technical acceptance remains recorded on `14f17469ed43fec4e3035d08612ea3b69cf849c3`; normal use remains paused. This local integration is not external acceptance or a reopening of F2.

- Current owned branch: `integrate/photo-program-offline-20261021`, based on preserved documentation checkpoint `601da9a0be3fa8b3fb0640043ae323cf5b4e4bb9` (`docs/photo-program-local-handoff-20261021`). Existing worktree reused; other workers' worktrees untouched.
- Preserved baseline branch: `fix/f2-w4-finalize-precheck` at `ecc117e1b9268014d2541c30bbd759221c5427e0`, retaining unpublished `eca9c35f462f4f4223e32a6f627e8d6d81ba6287` and `ecc117e1b9268014d2541c30bbd759221c5427e0`.
- Worktree/branch inventory inspected. C: free space verified once for this assignment: 11,334,057,984 bytes (about 10.6 GiB). No new worktree/dependencies/infrastructure installed.
- Applicable `CLAUDE.md` read; no applicable `AGENTS.md` or `LOOP.md` found. Current owner instruction explicitly authorizes local source edits, integration, tests, agents and scoped commits.
- Original numbered mapping remains unrecovered, per [#424 comment 6234693291](https://github.com/yali-code/noctella-web/issues/424#issuecomment-6234693291) and [FAZ A acceptance report](FAZ_A_ACCEPTANCE_REPORT_424.md). No repeat roadmap search, invented stage names or numeric advancement.

## Actual integration and historical source comparison

| Existing package / source | Comparison against `601da9a` | Result |
| --- | --- | --- |
| #473 `8e55552`: restore/recovery and fixed tenant scope | Suite absent; old same-bytes recovery reason superseded by copy-owned publication | Ported 4 SQLite restore-model cases. Updated collision reason and asserted all seven authority tables, committed publication intent, two copy records and persisted `tenant_id='noctella'` survive snapshot restore. |
| #473: metadata stripping/orientation | Suite absent; three recipe/storage APIs still compatible | Ported 4 cases for fixture preconditions, W2 recipe, legacy staged storage and W4 deterministic recipe. No claim of live-route or confined-worker acceptance. |
| #473: storage-error retry | Suite absent; old PG harness stopped before current intent/copy schema | Ported injected encoder-error recovery; PG setup advanced through 0044. No runtime owner changes. |
| #473: preflight Etsy-gap tests | Superseded by current released-Etsy/0043/0044 inventory assertions | Current assertions preserved; no obsolete gap assumptions restored. |
| #474 `34a0d16`: split-device preflight | Fix and two regression cases absent | Integrated canonical-parent mismatch rejection into current preflight, covering operations, publication and upload staging. |
| #474: destructive `down.sql`/rollback-reapply tests | Historical pre-F2 schema fixture; incompatible as current rollback guidance | NOT PORTED. No authority/intent/copy drop script changed. Added only dependency-refusal/schema-retention coverage, not successful destructive rollback. |
| #475 `9f63b6c`: migration compatibility | Existing `f2ReleaseCompatibility` already covers released fixture identity, 23 additive columns, SQLite preservation and PG forward/reapply through 0044 | Reused that file/fixture. Added missing alternate-order/catalog/nullability check and atomic dependency-refusal/schema-retention check. No duplicate historical draft fixture or obsolete seed enums. |
| #476 `b356732`: backup-driver preflight | Driver classification and regressions absent | Integrated SQLite-vs-PG instructions, both PG aliases and unknown-driver refusal. Existing F2 provenance/confinement/UUID/restart checks preserved. Current runbook qualification added. |
| Historical workflows and runbooks | Whole-file ports would remove newer F2 coverage or revive obsolete rollback instructions | No historical branch allowlists restored. Only appended 3 new suites to the existing PostgreSQL-required job. Current runbook preamble/evidence preservation retained. |

The historical side-stack acceptance records remain revision-scoped evidence, not test results for this candidate. Previous read-only GitHub review recorded #474/#475/#476 as open Drafts at the source SHAs above; no remote state was changed or CI launched here.

## Scoped implementation commits and independent reviews

| Commit | Work | Independent non-authoring agent review |
| --- | --- | --- |
| `71b5ea6bbcc73ccc7019e16521a275d0bf0d3318` | Preflight filesystem/backup-driver integration and current guidance | `compare_side_stacks`: exact-commit PASS. |
| `575e8b25b3ea93243725727970dfb28dbca139be` | Restore/metadata/injected-storage-error suites and PG-job wiring | `restricted_comparison`: exact-commit PASS after evidence-scope wording corrections. `compare_side_stacks`: exact-commit workflow compatibility PASS. |
| `5d3001ab3ade145559cfb29c1f7782dc00e48dc1` | Additional current-schema migration checks | `compare_side_stacks`: exact-commit PASS after narrowing schema-retention claim. |

Reviews are separate agent instances, not human review. The final handoff commit follows these implementation commits; identify it with `git log -1` on the branch. No self-review is labeled independent.

## Checks and evidence limits

| Check | Result |
| --- | --- |
| `npm.cmd test -w apps/api -- tests/photoReleasePreflight.test.ts` | PASS: 9/9. Read-only disposable-directory/simulated-device and driver cases. |
| Three ported suites, initial targeted run | 8 PASS, 1 FAIL, 2 SKIP. Failure was historical `REVIEW_FOREIGN_SAME_BYTES` expectation; current implementation reports `copy-owned publication main: COLLISION`. |
| Affected restore cases after adaptation (`-t 'structurally sound|NEWER'`) | PASS: 2/2 selected; remaining 2 cases intentionally not rerun after already passing. Combined evidence covers all 4 restore cases, 4 metadata cases and 1 SQLite encoder-error case. |
| New migration cases (`-t 'reconcile historical'`) | NOT RUN: both new cases skipped because disposable PostgreSQL is unavailable. Existing cases excluded by filter were not repeated. |
| `npm.cmd run typecheck -w apps/api` | PASS, including final test additions. |
| `git diff 601da9a HEAD --check` and scoped commit inspection | PASS before final report commit. Baseline refs preserved. |
| PostgreSQL encoder-error case / required-configuration guard | NOT RUN: no `POSTGRES_TEST_DATABASE_URL`; the conditional guard is inactive locally. A missing PG execution is not acceptance. |
| PostgreSQL/Linux infrastructure | BLOCKED locally: no psql command/configured disposable database; Docker daemon pipe absent; WSL enumeration access denied. No retry/escalation/install or target database contact. |
| Full suites, benchmark, restart matrices, builds and CI | NOT RUN: no concrete need to repeat accepted F2 checks; CI launch prohibited. Workflow wiring prepared only. |

Restore failures are same-process hook exceptions plus online SQLite snapshots, not SIGKILL/restart experiments. Committed replay checks row/count/generation/file-name stability, not restored-byte verification or backup completeness. The skewed-backup case checks main-file bytes/inode preservation and review state. Encoder exhaustion uses a mocked `sharp.toFile` rejection with libvips-style text, not a real full-disk/OS ENOSPC experiment. All test data is disposable/local. The new PG dependency test checks schema retention, not seeded evidence-row survival.

## Parked/restricted packages: concrete preparation only

**4B** remains parked and unintegrated: `feat/f2-instagram-derivative-store`, implementation `05dc70f09d311491377609795cef057f6fdeab48`, review fixes `442181b82f322b7391472c179a4787d48e97ab1f`. Source comparison found common ancestor `dfa3c656bbc3507bf0a71405a78e52ab3e5581c1`; current production files touched by 4B are unchanged from it. Writer-census overlaps add persistent-identity entries separately from 4B's Instagram entries. Preserve both commits: retryable confined-worker failure and nested dotfile serving fixes matter. Future authorized integration would reconcile census entries, run Linux confined-path evidence and reaccept the changed Instagram path on the resulting revision. No clean-merge or runtime compatibility PASS is claimed. The full protected workload still expects W11-table evidence; a separately reviewed evidence-contract change would be needed for separate-store derivatives, not merely clearing BLOCKED. Existing write-only launcher limitation remains documented; no new hardening gate invented.

**4C** remains unimplemented/parked. Existing release §5 options: deletion authority only for committed-operation keys whose photo row is gone, under the intent lock; or operator-reviewed periodic cleanup. Relevant boundaries are `productPhotoStorageWorkflow.ts` (W8), `aiIntakeCleanup.ts` (W6), and the writer-adoption/crash-recovery documents. Missing keys, unknown reference state, stale outbox events and mixed-version writers prohibit deletion; age/TTL grants no authority. No deletion design, cleanup or evidence deletion implemented.

**W11/0042** stays dormant. Preserve [recorded denials](W11_SECURITY_REVIEW_AND_OWNER_DECISIONS_424.md#1-the-three-recorded-safety-denials-closure-mission-comment-6224053880): live refusal removal (Security Weaken), default-OFF development variant (Auto-Mode Bypass), three additional owner tests (Security Weaken). None retried. Latest release also records rejected agent production reads/actions; none retried.

**Decisions/dependencies consolidated:** existing F2 availability limitations and 4B/4C parking remain accepted. Future retention/private-generation backup scope, PostgreSQL-native consistent backup/verified restore/photo recovery point, changed Instagram integration, deletion authority and release remain distinct owner-controlled work. Current assignment does not authorize those policies or external actions. Changed-device recovery and power-loss durability remain documented limits, not reopened F2 gates. Original numbered criteria are still required to justify any move beyond 5/12.

## Tool incident and stopping point

During read-only 4B research, the separate agent mistakenly invoked `git merge-tree --write-tree 601da9a 442181b`. It attempted shared Git object writes and failed with insufficient permission. It was not a successful read-only merge verification. No retry, escalation, alternative merge attempt or tracked-file change followed; the agent continued with source/history inspection only.

All identified ready unrestricted ports from #473–#476 are implemented or explicitly reconciled as present/superseded/incompatible above. Remaining execution requires unavailable local PG/Linux or prohibited external/restricted work. Stop at this local candidate: no pushes, PR/issue writes, remote merges, CI launches, target access, deploys, environment/secret changes, paid resources, marketplace publication, destructive cleanup, automation or normal-use resumption. Named local deliverables and numeric program acceptance remain separate.
