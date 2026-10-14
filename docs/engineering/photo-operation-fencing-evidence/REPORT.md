# Issue #403 evidence and acceptance report

Draft #404, branch feat/photo-operation-fencing-p2-2b3c, exact parent #402 a4c3ea7602884934c2e1feda190506a8bac2133b. Delivery is **diagnosis/design and disposable tests only**. Runtime durable ownership/fencing acceptance is **BLOCKED**, not completed by these experiments. The full technical design and mutation inventory are in ../P2-2B3C_PHOTO_OPERATION_FENCING.md.

## Verified dependencies and isolation

Parent delivery CI573 (run38556010568) completed SUCCESS. Parent #402 source CI572's 15 SQLite/15 real PostgreSQL crash workflows and 51 integration results were reviewed along with #398 retention/ambiguity evidence and #396's remaining gate. New worktree C:/Users/Admin/noctella-web-p2-2b3c starts at the requested exact head. No codec, Etsy or parent branch work was modified.

source-manifest.json records Git tree identity for apps, packages and scripts/photo-crash-recovery: all are identical to #402. This is stronger than a flag-OFF shim claim: no production module, route, storage API, schema/migration, feature default, package dependency or parent crash harness was changed. The only executable additions are scripts/photo-operation-fencing/*.cjs, invoked explicitly in bounded CI against guarded disposable fixtures.

## Measured counterexamples versus assumptions

1. Existing storage compensation: a proposed generation advances, then the real LocalStagedProductPhotoStorage.deleteProductPhoto still removes the explicitly created newer-generation synthetic output and thumbnail. Its API has no token/reference checks. This shows a journal alone cannot fence it; it does not assert a production occurrence or existing journal adoption.
2. Actual SQLite lock capability: it rejects the Promise callback and rolls back, but after a barrier the still-running callback overwrites a synthetic newer-owner file. Promise rejection is not asynchronous/native cancellation.
3. Actual deterministic finalization, two child processes with shared admission enabled independently: older red encoding pauses after readFile ENOENT; after reclaim, newer blue encoding succeeds; resuming old changes the main SHA-256 and then fails with AiIntakePhotoFinalizationDestinationConflictError on the unchanged newer thumbnail. Tiny32x24 PNG inputs use the unchanged actual product recipe. Different input colors intentionally model missing immutable retry identity. Complete before/after hashes are raw evidence; no historical incident is inferred.

These counterexamples are expected assertions in the suite. A passing counterexample is evidence that runtime adoption remains blocked. No repair/deletion/quarantine mechanism is introduced. The compensation counterexample is the only intentional deletion and calls an existing API solely on two explicitly created synthetic files in its own disposable root.

## Positive protocol experiments and scope

The test-only probe_photo_* schema preserves intent, owner boot/nonce, increasing generations, per-generation input/output references and history. Conditional claim/renew and photo+outbox+operation commit are actual SQLite/PostgreSQL transactions. Commit checks authoritative photo/event linkage, rollback preserves the previous state, and simulated post-commit response loss is reread without duplicate rows or generation reuse. It is not a production repository, migration, request-idempotency interface or complete AI/Instagram artifact schema.

Independent processes compete for one expired generation: exactly one wins. Exact-expiry/renewal and ABA/duplicate-nonce rollback are deterministic injected-clock tests, not production lease-duration measurements. Held synchronous publication prevents independent reclaim with SQLite SQLITE_BUSY / PG55P03; reclaim succeeds after release. An already-open old-generation file descriptor can write only its old namespace in the positive fixture, leaving newer bytes unchanged. DB unavailability before the critical section refuses the callback and preserves bytes. Abort/review/zero-byte retention are modeled; this is not full runtime SIGTERM/native-drain validation.

Six SIGKILL checkpoints per DB: durable intent before any file; zero output reservation; completed materialization before prepared; prepared before domain commit; photo/outbox/journal inside uncommitted transaction; all committed before response. Two new connections after death agree on durable state; zero-byte and completed outputs are retained. SQLite uses actual WAL. PG server stays alive and uses isolated migrated schemas. Protocol fixture payloads are synthetic strings; the separately unchanged parent crash matrix exercises real Sharp/service workflows. Neither is a power-loss/fsync or cgroup memory acceptance test.

Outbox-only history is a real inserted DeadLetter event without a photo row. Existing retain-only reference planner protects its zero-byte referenced key; status, lease expiry, missing record or file age never grants mutation. Full publishing/backup/reference census remains unimplemented.

## Local observations and raw preservation

Final local run at source5d5ddfa01f3e8d45b4685167d2836c7ccdef6b8e: 35 tests, **18 passed, zero failed, 17 PostgreSQL skipped** because no local PostgreSQL endpoint is available. Windows process termination is not described as POSIX SIGKILL evidence. Earlier prototype runs/logs are also retained.

The first newly added deterministic race diagnostic failed its preflight handshake. The fixture was missing its local createRequire helper; after correcting the fixture and early-exit reporting, the targeted race passed and the complete suite passed locally. Original failed TAP, disposable snapshots and corrected results are retained, not suppressed or substituted for Linux evidence.

archives/local-experiments.zip preserves all six task-specific local evidence roots, including failed and successful runs: SHA-25686db392db6f3b6ef5a2de0677bc4e7e953b4987fea7a73e9aa5003e2767b1ea1. UTF-8 transcriptions of original PowerShell Tee-Object logs are in local/. Original raw working files/roots remain preserved locally. GitHub artifact ZIPs will be preserved byte-for-byte with verified digests, including both preliminary and final source runs.

## Linux CI results

Final source validation completed; results below supersede pending status. CI574 (d43ea6a9334841eebf232d2fe413572f7e1dc542) runs the initial33 experiment cases; CI575 (5d5ddfa01f3e8d45b4685167d2836c7ccdef6b8e) includes the final two deterministic-race cases. The unchanged37 crash cases and51 PG integration cases run separately from the prototype, plus API/Admin/Storefront regressions, typechecks/builds/lint. Exact observed counts, original artifacts, hashes and final source are appended after completion. No runtime acceptance is claimed from green CI.

## Reproduction, restrictions and rollback

Run from repo root with built shared package and installed project dependencies:

    npm run build -w packages/shared
    node --import tsx --test scripts/photo-operation-fencing/fencing.test.cjs
    node --import tsx --test scripts/photo-crash-recovery/recovery.test.cjs
    npm run test:postgres -w apps/api
    npm run typecheck --workspaces --if-present
    npm test --workspaces --if-present
    npm run build --workspaces --if-present
    npm run lint --workspaces --if-present

Use only CI's disposable local PostgreSQL16 service with an explicitly test-named database. Each probe owns one unique test schema and guarded os.tmpdir/noctella-photo-fence-* root. Worker command lines/logs do not include database URLs. Provisional production TTL, rollout epoch and full artifact schema must be separately implemented/validated, not copied blindly from test clocks. The prototype exposes trusted callbacks and numeric bounded test generations; it is intentionally unsuitable as a production mutation capability.

Rollback removes this stack's docs/scripts/CI experiment step. No database/data migration or runtime rollback is needed. Retain all raw evidence and unknown files. #403 runtime adoption is blocked on generation-isolated storage capabilities, sealed/no-overwrite publication, connection-loss safety, all-writer rollout coordination and complete authoritative identities. #396 remains OPEN for reconciliation/full reference checks; #390 remains OPEN for original24-MP512-MiB/384-MiB gate. No production/Render/provider access, paid service, merge, deploy, automatic deletion or quarantine.

Future runtime work must replace the five baseline counterexample assertions with stale-writer rejection/byte-preservation regressions. Their current passing status documents an unsafe baseline; it must never be used as a runtime acceptance gate that requires preserving the bug.

Preliminary CI574 (run38558830219) completed SUCCESS: ownership33/33, crash37/37, PG51/51, API6106 passed/34 optional skips, Admin925, Storefront376; all typechecks/builds/lint passed. Original archives: ci574-ownership.zip artifact11892078513 SHA-25681407fe5796a2c4dc7658c29c6d523714ca6d06e5503444f476b794407a32158; ci574-crash.zip artifact11892003405 SHA-2567b33c04a5f2b937dbe5375d15721a6e3f20fd3cdeb92a4df023b59581971b324. Final two deterministic-counterexample cases are absent from this preliminary source and are not credited to it.

## Final Linux observations — CI575 SUCCESS

Source5d5ddfa01f3e8d45b4685167d2836c7ccdef6b8e; [CI575](https://github.com/yali-code/noctella-web/actions/runs/38559372096) completed SUCCESS on every step. Final documentation/evidence delivery contains identical experiment/CI source blobs, recorded in source-manifest.json.

| Validation | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Final disposable experiments | 35 | 0 | 0 |
| Unchanged original crash harness | 37 | 0 | 0 |
| Existing actual PG integrations | 51 | 0 | 0 |
| API regression | 6106 | 0 | 34 |
| Admin regression | 925 | 0 | 0 |
| Storefront regression | 376 | 0 | 0 |

All workspace typechecks, builds and lint passed. The API skips are optional/unconfigured integration cases in that general invocation; the separately configured PostgreSQL command passed51/51. All15 SQLite and15 actual PostgreSQL photo workflows passed unchanged fixtures/checkpoints. Twelve additional ownership-prototype workers were SIGKILLed on Linux and durable state survived reconnect/restart. No memory measurement or runtime recovery acceptance is inferred.

The35 experiments comprise30 positive model/transaction schedules (15 per DB), plus five expected unsafe-baseline counterexamples (SQLite3, PostgreSQL2). Thus18 SQLite/17 PostgreSQL experiments passed. final-results.json includes all35 named case inventories, twelve SIGKILL records and the five explicit counterexamples with observed hashes/conclusions; complete original artifacts include TAP, snapshots and synthetic files.

Original final artifacts: ci575-ownership.zip, id11891359619, 4,499,534 bytes, SHA-25682ffc66407f3dd7e31d1e65765f825725909a41a3eb81fcfd463d7792abd7cc7; ci575-crash.zip, id11891814591, 4,017,367 bytes, SHA-2569541b19d265b7ab62f40b038331782af0ac89f59d113b7ad784c67c1e45b04c1. All four Linux ZIPs plus local-experiments.zip are committed byte-for-byte; archive-manifest.json verifies each. Evidence does not depend solely on GitHub's14-day artifact retention.

Final result: **design/test deliverable validated; runtime #403 ownership/fencing BLOCKED**. No runtime file, production schema, feature default or original crash harness changed. All protected parent PR heads were verified unchanged. No deletion/quarantine policy, migration, merge, deployment or production access occurred. #396 and #390 remain open.
