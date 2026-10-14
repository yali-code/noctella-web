# P2-2B3A — measured crash/restart evidence and unresolved recovery gates

Issue [#396](https://github.com/yali-code/noctella-web/issues/396), Draft [#398](https://github.com/yali-code/noctella-web/pull/398), independent base [#392](https://github.com/yali-code/noctella-web/pull/392) at `6eca0afcda2ee5a96126818234b4429f5ae9ecfd` (CI550 verified successful). [Architecture, owner inventory, future protocol and rollback](../P2-2B3_PHOTO_CRASH_RECOVERY.md).

**Result: narrow gated source-retention safeguard validated; automatic crash reconciliation and complete PostgreSQL photo workflows remain BLOCKED. No claim of production readiness or closure of #396/#390.** No canonical/private file is automatically deleted, moved, repaired or declared unreferenced by this delivery. Feature defaults and production remain unchanged.

## Final measured source

`e6bc0a9d45e23ea172b9ade16ff3df3fa9958a8c`; [Linux CI566 / run38544583309](https://github.com/yali-code/noctella-web/actions/runs/38544583309). Later evidence/documentation delivery commits do not change application, scripts or workflow source; exact source equality is verified before delivery.

GitHub-hosted Ubuntu runner, repository Node20 CI setup, local disposable PostgreSQL16 service with full migrations, and retained file-backed SQLite WAL. Actual checkpoint metadata verifies platform=linux, physical termination=SIGKILL for all19 completed fault cases, journalMode=wal for all15 SQLite cases and source SHA for every record. The killed process is the API-service probe, not the PostgreSQL server. No external provider calls or production DB/data/credentials are used. Tiny32×24 synthetic images make deterministic boundary tests inexpensive; they are not 24-MP OOM or memory-budget measurements.

Final Node test output: **37 tests;22 passed,15 explicitly blocked/skipped,0 failed**. Passing tests comprise3 pure planner tests,15 real-service SQLite crash/restart cases,3 native PostgreSQL transaction fixtures and1 actual PostgreSQL AI persistence-error safeguard case. The15 skips are unsuccessful PostgreSQL photo-service preflights, not accepted recovery cases.

## Observed outcomes

| Driver and boundary | Photo / AI / outbox rows after first restart | Retained state / retry outcome |
| --- | --- | --- |
|SQLite AI reserved output|0 /0 /0|Ingress input + zero-byte private output retained. No fabricated successful upload.|
|SQLite AI encoded-before-row or uncommitted row|0 /0 /0|Complete private source retained; uncommitted row rolled back.|
|SQLite AI committed-before-response|0 /1 /0|Committed row and source retained.|
|SQLite AI lost acknowledgement, new safeguard|0 /1 /0|Source retained; fixed503 and closed admission. Enabled work rejected; legacy wrapper bypass still works.|
|SQLite AI definite rollback error|0 /0 /0|Source retained conservatively and admission closed; no guessed delete.|
|SQLite first product hardlink|0 /0 /0|One canonical alias and private pair/input retained. Raw dev/ino/nlink assert shared main inode with link count2.|
|SQLite product uncommitted transaction|0 /0 /0|Both complete canonical outputs retained.|
|SQLite product committed or lost acknowledgement|1 /0 /1|Photo + promotion event atomic; files retained by existing product policy.|
|SQLite finalization before commit|0 /1 /0|Applied intake and source retained. Retry succeeds once, then returns created=false; one deterministic photo and one outbox event.|
|SQLite finalization after commit|1 /1 /1|Finalized intake; both retries created=false; bytes/source/IDs/outbox remain stable.|
|SQLite first deterministic output|0 /1 /0|Existing complete main reused, missing thumbnail prepared on retry, then idempotent second retry.|
|SQLite injected zero deterministic output|0 /1 /0|Both retries raise AiIntakePhotoFinalizationDestinationConflictError. Zero file, source and DB state remain unchanged; no overwrite/deletion.|
|SQLite Instagram temp-before-link|1 /0 /0|Canonical source protected; abandoned JPEG temp retained. No provider/publishing operation.|
|PostgreSQL native SQL fixture before commit|0 /0 /0|All three uncommitted record types roll back after API-child death; prepared image files retained.|
|PostgreSQL native SQL fixture after commit|1 /1 /1|Committed metadata/outbox and files remain protected.|
|PostgreSQL outbox-only committed fixture|0 /0 /1|DeadLetter delete-event payload keys protect canonical files even without their photo row.|
|PostgreSQL actual AI persistence-error handler|0 /0 /0|Directly seeded Open intake reaches actual staged storage/service; failed persistence retains72-byte source plus126-byte input and closes admission with503. This is not successful upload acceptance.|

Two fresh inventory processes/connections return identical snapshots and plans before any retry, including source/canonical hashes. Complete deterministic retries preserve source bytes, photo IDs and canonical bytes and do not duplicate outbox. The explicit zero-output fault is injected at interrupted-open-before-write, rather than claimed as a sampled native encoder write. Input request directories are fixture-owned, representing the service storage boundary; these tests do not exercise live HTTP multipart interruption.

The earlier baseline Windows test at #392 deliberately reproduces the unsafe post-COMMIT compensation: one committed AI row, no private source file. Raw record is `baseline/sqlite-ai-lost-ack.json`; baseline source is preserved in `baseline-ai-service.txt`. Windows termination is labelled win32 and is not POSIX SIGKILL evidence, regardless of Node's reported signal label. The corrected Linux source has the row and its file and a closed admission gate. No historical production loss is inferred.

## PostgreSQL blocker — verified, not hidden

The original actual-service matrix fails during intake creation with **TypeError: value.toISOString is not a function**, stage=create-intake. The baseline repository sends ISO string timestamps to Date-mode PostgreSQL columns. Full error/stage evidence is retained in `final-linux/*/blocker.json` and the summary. The15 blocked matrix entries share this setup failure; this does not prove every individual PostgreSQL helper is intrinsically unusable.

Tests do not adapt production schemas, replace timestamp encoders, normalize dates in a fake DB or pretend these services committed. Only this exact known setup failure becomes a labelled skip; any different failure remains a failing test. Three native-SQL fixtures separately exercise migrated PostgreSQL transaction/restart/reference semantics with actual local storage; the fourth case seeds an intake with server defaults and verifies the real AI retain-and-close failure path. These passes cannot substitute for complete PostgreSQL photo upload/finalization validation. Repository timestamp compatibility and the complete matrix remain future engineering gates.

## Verification

- Local Windows:15 supported crash-boundary cases and3 planner tests passed before final WAL/Linux verification;245 scoped API regressions passed across8 suites, covering AI/photos/finalization/cleanup/shared admission/product outbox. Shared/API builds and API typecheck passed.
- Final Linux source:22 passing /15 blocked new crash/planner tests,37 total; no failed new tests. Source hashes, SIGKILL outcomes and SQLite WAL modes were checked against raw artifacts.
- **Full software CI566 PASSED** on the final measured source: all workspace tests/typechecks/build/lint and the existing real disposable PostgreSQL integration suite. API6,092 passed/33 skipped; Admin925 passed; Storefront376 passed; PostgreSQL integration36 passed. The new crash suite separately reports22 passed/15 blocked. Delivery-head CI is recorded in the Draft PR. Green software CI never turns the blocked PostgreSQL photo matrix or automatic recovery into accepted results.
- Source whitespace and structured JSON checks are applied separately from raw upstream test logs, which retain their original formatting.

## Raw artifacts and failure history

All four complete original ZIPs are permanently committed under `archives/`, including synthetic SQLite DB/WAL files, generated media, checkpoints, snapshots and raw test-output logs. PostgreSQL is serialized via consistent primary snapshots, not physical server backups. These archives are evidence, not production restoration inputs. `artifact-provenance.json` verifies their exact SHA256 and byte length. Readable JSON/TAP evidence is also retained in named directories. No long-term dependence on Actions14-day retention is required for these files.

| Run / source | Outcome | Complete artifact | SHA256 |
| --- | --- | --- | --- |
|38543210243 /253b74c77addf5ab662f9d757b719d3553b7bc4f|Initial SQLite cases pass;15 PostgreSQL setup failures; later software steps skipped|11882769801 /ci562.zip|9408b084be27da9ddf5d76558daa84c1f80d0afba36970fe8d655afd3b7b1b49|
|38543448141 /2fc5edc259f98a74b6b4b0ec69b711045d6a0be2|SQLite WAL passes;15 PostgreSQL setup failures; later software steps skipped|11883596494 /ci563.zip|bae65a88eebbfa208a872618508ee3b4b38233fa1ebb55a76ca3e4e06ffd956a|
|38544390009 /77fd85947d81aa4fccb0499decca6e4e43fbf4af|21 pass /15 explicitly blocked;3 native PostgreSQL fixtures pass|11884340736 /ci564.zip|99e61cf3470e31f51b7d4f2d4b24bd9927dbbb3936ccb374192ca9879ec1db2e|
|38544583309 /e6bc0a9d45e23ea172b9ade16ff3df3fa9958a8c|Final22 pass /15 blocked; adds actual PostgreSQL AI error-handler validation|11883538427 /ci566.zip|53a5b374bca7a9df783ecb6023080add25d8e587700bcf926e4f340c807177d2|

Local harness setup initially failed because a reused dependency junction pointed at an unbuilt shared package; a test-only child resolver now targets this worktree's built shared package. Two early finalization assertions used capitalized enum values; they were corrected to the real applied/finalized contracts. Those local attempts did not establish Linux/PostgreSQL acceptance. All disposable fixture roots remain preserved; raw Linux failure artifacts above were not discarded or reclassified as successes.

## Remaining gates and rollback

Automatic reclamation/quarantine cannot be proven safe with today's process-only ownership and incomplete reference coverage. The architecture specifies durable intent, stable IDs, fencing/lease generations, primary DB/outbox checks, conservative journaled quarantine, idempotent interrupted transitions, explicit operator review and disk/ENOSPC headroom. It is not implemented or authorized for production by this Draft.

The prototype reclaims zero bytes by design and does not remove any referenced or unproven file. Snapshot logical bytes count path names and can double-count hardlinks; they are not physical disk peaks or production disk reductions. No hard quota, crash soak, power-loss guarantee or512-MiB/384-MiB memory acceptance is claimed. #390 remains blocked independently of this recovery work.

Keep disk staging and cleanup execution disabled. No new schema/key migration exists. Reverting the gated catch restores the former possible destructive compensation; keep the feature disabled and preserve/review retained files and authoritative DB/outbox history before any restart/retry. Full automatic recovery, PostgreSQL service compatibility and live enablement require separate completion/review. No merge, deployment, live database, Render, customer media, credentials or provider writes occurred.
