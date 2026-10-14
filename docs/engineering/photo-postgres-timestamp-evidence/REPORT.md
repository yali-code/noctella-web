# P2-2B3B PostgreSQL photo timestamp compatibility — Issue #401

Stack: PR #402 on #398, exact dependency f89d3a1d430948c0ed165da7fcd624251bbdb46d. Parent branches are preserved. Timestamp/crash-workflow acceptance PASSED on the final runtime implementation below.

## Reproduction before repository changes

CI 568, run 38552563961, source 1da4beb8feb3eaf69749fc01759b5f6b2cfa1565 changed only the pull-request target allowlist. All runtime and crash code remained identical to #398. Disposable local PostgreSQL 16 and SQLite, synthetic 32×24 images, real repository/service calls and original SIGKILL procedure were used. 22 tests passed; all 15 full PostgreSQL workflows were explicitly blocked at create-intake with TypeError: value.toISOString is not a function. A green baseline workflow is not PostgreSQL crash acceptance: its 15 blocked tests were skips.

Complete raw evidence is committed in archives/ci568-before.zip (artifact 11887830652, SHA-256 a1b180a0c809bc998000c7f9f5bef21d5eb356f984812d892941fc2e856a82ac). It contains the original 15 blocker records, TAP and SQLite databases/files/checkpoints; PostgreSQL logical state is captured as JSON, not a server data-directory backup.

## Verified cause and repository fix

PostgreSQL schema timestamp(..., { withTimezone: true }) columns use Drizzle Date mode. Installed drizzle-orm 0.45.2 PgTimestamp.mapToDriverValue calls value.toISOString(). AI intake create/cancel/apply/finalize and AI photo insert previously passed application ISO strings directly. The shared canonical photo/promotion-event insert similarly passed ISO values for photo and outbox timestamps.

A narrow adapter converts only named timestamp fields on those Date-mode write boundaries, accepts valid native Dates, requires explicit zones for string values and rejects invalid/ambiguous timestamps. SQLite text inputs stay byte-for-byte unchanged. Repository read results for intake and private photo audit fields normalize native Dates to ISO strings, preserving the declared contract. No schema/migration, clock source, use-case timestamp, identifier, storage key, outbox key, image recipe or retry policy changes are intended.

The previous pg-ai-persistence-error probe depended on this compatibility bug. It now injects a deliberate transaction failure into the real service so it continues to verify source retention and admission shutdown after timestamps are valid. The obsolete create-intake blocker skip is removed. Crash snapshots now include audit/scheduling timestamps; UTC validity and event creation/availability equality are asserted. Image fixtures, kill checkpoints and filesystem retention remain unchanged.

## Intermediate failures

CI 569, source 716d3e3b2a73cf012f1559394d41e0fa5a662837, reached actual PostgreSQL operations: 30 passed, 7 failed, zero skipped. Complete raw evidence: archives/ci569-intermediate.zip, artifact 11887802118, SHA-256 555b21ea88cf3f849d0a2f0e976d312babd8c53a99fa8b84ef2481581bfc96ca. This revision also predates the explicit persistence-error injection. Product persistence/finalization follow-on failures require real-driver diagnosis; no acceptance claim is made from this revision.

## Scope and remaining gates

Default staging flag remains disabled. The parent ambiguous-commit admission guard remains intact. There is no recovery executor, automatic file deletion, live customer media, production database, provider write, deployment or infrastructure change.

Issue #396 ownership journals, writer fencing and comprehensive reference coverage remain separate unresolved recovery gates. Issue #390's 24-MP/384-MiB resource acceptance is unchanged and not established by tiny crash fixtures. These tests kill a photo worker process while PostgreSQL remains alive; they do not simulate a PostgreSQL server crash, network partition, power loss or full API multipart OOM. PostgreSQL raw evidence is a logical inventory under a repeatable-read snapshot.

Rollback: revert this stacked repository/CI change in development, retain evidence and any ambiguous files, and leave staging disabled. No schema rollback/data migration is necessary. Reverting restores the known PostgreSQL timestamp blocker, so it is not a PostgreSQL readiness strategy. Never delete retained inputs or zero-byte outputs based only on age, filename or absent rows.

## Verified follow-on PostgreSQL flag compatibility

CI 571 (run 38553903211, source 423af243823ced18d61277bb9046b8f93195e7c0) completed 31/37 crash tests, six failed, zero skipped. Its additional real repository test identified PostgreSQL error 22P02: invalid input syntax for type integer: "true" on product_photos.is_primary. Both schemas intentionally differ: PostgreSQL integer versus SQLite boolean-mapped integer. This is a second, previously masked repository adapter defect, not a timestamp or recovery failure. The narrow photo write boundary now converts boolean isPrimary to 0/1 only for PostgreSQL, preserving primary-selection meaning and SQLite behavior. No schema migration is used. This additional change is necessary for the unchanged full product/finalization crash matrix to reach its transaction checkpoints.

## Local validation and its limits

On Windows, the unchanged SQLite crash baseline passed all 15 photo workflows (18 tests including planner checks; 19 PostgreSQL cases unconfigured/skipped). The post-change SQLite run also passed all 15 workflows with added UTC timestamp assertions. Final targeted Vitest regression run passed 190 tests, one PostgreSQL test skipped because no local PostgreSQL endpoint is configured. API typecheck and build passed. The reused dependency junctions were read-only reuse; the isolated shared package was built locally without changing a parent worktree's package output.

The broad Windows API run reported a timeout in the existing Stripe response-loss restart case (6014 ms), then produced no further output for several minutes and was explicitly interrupted. Its partial output is retained in local/b3b-local-api-tests.txt; it is not a passing full-suite result. No unrelated Stripe code or test threshold was changed. Linux CI with clean dependency installation is the full regression environment. Local text logs are UTF-8 transcriptions of PowerShell Tee-Object output; original files remain preserved locally. Complete GitHub crash artifact ZIPs retain their original bytes.

Reproduction commands (from repo root; use only the workflow's disposable local PostgreSQL service and synthetic environment):

```sh
npm ci
npm run build -w packages/shared
node --import tsx --test scripts/photo-crash-recovery/recovery.test.cjs
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm run test:postgres -w apps/api
npm run build --workspaces --if-present
npm run lint --workspaces --if-present
```

POSTGRES_TEST_DATABASE_URL must point to a disposable test database; each probe creates and drops only a unique test schema. The worker additionally requires localhost and a guarded temporary-directory prefix. Feature enablement exists only inside synthetic worker processes. CI artifact uploads run even on failure and include actual PostgreSQL repository diagnostics.

## Final measured acceptance — CI 572

Implementation source: 23b85b79eec53dc8cac8642c01daebc60e884039. [CI 572](https://github.com/yali-code/noctella-web/actions/runs/38554494946) PASSED all steps. Final delivery changes following this revision contain only documentation and evidence, with identical implementation Git blobs listed in evidence-manifest.json.

- Crash harness: 37 passed, zero failed, zero skipped. All 15 actual PostgreSQL workflows and all 15 SQLite workflows passed unchanged image fixtures and kill procedure. Additional coverage: three planner tests and four PostgreSQL protocol/persistence-error fixtures, kept distinct from full workflow acceptance.
- Every killed Linux worker reports SIGKILL. Fresh-process snapshots agree. Atomic photo/outbox state, rollback, commit, lost acknowledgement, deterministic repeated finalization, source hashes, zero-byte output refusal and retain-only planning assertions pass. final-matrix.json summarizes all 34 process-kill records; full snapshots/checkpoints/databases/synthetic files/TAP remain in the original ZIP.
- Actual PostgreSQL integration command: 51 passed, zero failed/skipped across seven files. This includes the existing 36 integrations plus 15 timestamp/real repository tests. The separate general API invocation has PostgreSQL configuration intentionally absent; its PG skip does not replace this explicit configured run.
- Full API suite: 6106 passed, 34 skipped (existing optional PG suites plus the new unconfigured PG case). Admin: 925 passed. Storefront: 376 passed. All workspace typechecks, builds and lint passed. The broad Windows partial timeout does not alter or substitute for these complete Linux results.

Final original artifact: 11890126054, archives/ci572-after.zip, 4,016,187 bytes, SHA-256 52f96bad6314930c1913367287be269df580ca8e0be716400c935b14d2a00d41. Intermediate CI570: artifact11887817245, SHA-256 54e94832f225b6dd54f55b926d6fbd9796a6f798421e6d36ac3a8d8765d3b344. Intermediate CI571: artifact11887912394, SHA-256 632bd443ba9c6119ff1e8e419322e4d3cb2c3eb5f6f4166d50ca53f9d2d82cd3. All five original before/intermediate/after ZIPs are committed; no failed evidence was overwritten. GitHub's short-lived artifact retention is not the sole evidence store.

| Boundary | PostgreSQL | SQLite |
| --- | --- | --- |
| AI reserved output / encoded output / uncommitted / committed / lost acknowledgement / rollback error | 6 passed | 6 passed |
| Product first link / uncommitted / committed / lost acknowledgement | 4 passed | 4 passed |
| Finalization uncommitted / committed / first output / zero output | 4 passed | 4 passed |
| Instagram temporary derivative before publication | 1 passed | 1 passed |

No #401 timestamp blocker remains. This result unblocks the PostgreSQL crash matrix only; it does not close #396 or #390, authorize automatic deletion, enable features or establish production readiness.

Files changed: photoTimestamps.ts; AI intake and AI photo Drizzle repositories; product-write Drizzle photo boundaries; photoTimestampCompatibility.test.ts; explicit PostgreSQL test command; crash worker's deliberate persistence-error fixture; crash timestamp inventories/assertions; CI stacked-target/always-retained diagnostics; this evidence directory. Services, admission controller, storage implementations, image recipe and schemas are unchanged from #398.
