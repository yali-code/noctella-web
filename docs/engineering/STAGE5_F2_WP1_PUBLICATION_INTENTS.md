# Stage 5 F2 WP1 — runtime publication-intent foundation — #472

Base: `0db58445d2aec2be1f006827bd545c67014a2a79`. Branch: `feat/f2-wp1-publication-intents`. This work package adds a durable schema and a runtime module. It is **not wired** into anything. No owner, route, flag, launcher, copy publisher, Render or provider change is made. The vulnerable runtime paths are unchanged: `uploadFencedProductPhoto` and `buildFencedAiIntakePhotoFinalizationManifest` still link the worker-owned inode under the lease-only fence.

**Runtime Photo F2 remains HIGH/FAIL. Production availability remains NOT ACCEPTED. Official progress remains 4/12.**

## Schema (migration 0043, forward-only)
`apps/api/src/db/postgres-migrations/0043_photo_publication_intents.sql`, with identical DDL appended to `apps/api/src/db/schema.sql`. SQLite picks it up through `ensureSchema`.

0043 is the next unused number. 0039 (Etsy) and 0042 (W11 proposal) stay reserved and untouched; `photoReleasePreflight` still reports them as WARN gaps.

- **`photo_publication_intents`**
  - Keys: PK `operation_id` → `photo_operations`; UNIQUE `seal_id` → `photo_operation_artifacts`; UNIQUE `executor_token`.
  - Bound tuple: `generation` (BIGINT > 0), `owner`, `nonce`, the sealed main/thumb identity (sha256, dev, ino) and `executor_epoch` (BIGINT ≥ 1).
  - Executor columns: `executor_identity`.
  - State: `authorized | committed | review`.
  - There is no expiry column.
- **`photo_executor_exit_records`**
  - PK `(operation_id, executor_epoch)` → intent.
  - Columns: `executor_identity`, `attested_by`, `exit_observed_ms`.

The migration is additive: two `CREATE TABLE IF NOT EXISTS` statements and nothing else. The repository has no down migrations (`rollbackMigrationBatch` is metadata-only), so WP1 follows the forward-only convention. The supported recovery strategy:

- Revert the application code. With no intent rows, the tables are inert and the existing claim and lease paths behave as before (this is tested).
- Any schema correction is a new forward migration. An applied migration is never rewritten.

## Runtime API (`apps/api/src/services/photoPublicationIntents.ts`)
| Export | Contract |
| --- | --- |
| `acquirePublicationIntentSteps` / `acquirePublicationIntent` | **T1.** Locks the `photo_operations` row (PostgreSQL `FOR UPDATE`, SQLite `BEGIN IMMEDIATE`), then reads the intent.<br>• An existing intent is classified: `own` (same token AND identity, a lost-ack retry), `held-by-other`, `rejected` (other generation, owner, nonce or seal) or `terminal`.<br>• With no intent, admission requires the current sealed generation, the seal and a **live DB-clock lease**; it then inserts epoch 1.<br>• A unique violation is re-classified in a **fresh** transaction (the W2 convention). A violation without an intent for this operation fails closed (`rejected`). |
| `guardedReclaimSteps` | Same row lock. Returns `in-progress` while the intent is `authorized`, whatever the lease says. Otherwise it delegates to the unchanged `claimExistingOperation`. |
| `persistAuthenticatedExecutorExitSteps` | **Trusted caller boundary.** It only RECORDS an exit the caller has already authenticated (e.g. the Step 2 supervisor `COMPLETE` bound to the reaper's `INNER_EXIT`). It authenticates nothing. It must never be called on a lease expiry, timeout, missing heartbeat or worker-supplied PID. One record per epoch: a mismatching record cannot be replaced, so that operation stays BLOCKED (fail closed). |
| `transferPublicationAuthoritySteps` | Epoch n → n+1 under the row lock and an intent `FOR UPDATE`.<br>• Requires an exit record for epoch n whose identity equals the intent's current `executor_identity`.<br>• The update is a CAS on the epoch.<br>• Results: `own`, `no-exit-record`, `lost`, `terminal`. |
| `reviewPublicationIntentSteps` | Existing `reviewSteps`, plus the current executor's intent moves to `review` (guarded by epoch and token). |
| `commitIntentAuthorizedPhotoOperation` | The commit fence for the caller's photo + outbox transaction. It uses the real predicates of `commitDrizzlePhotoOperationFenced` **minus only the lease**, plus `EXISTS` on the authorized intent with the full tuple (generation, owner, nonce, seal, epoch, token, identity). It commits the operation, the generation history and the intent; each statement must affect exactly one row, otherwise `PHOTO_OPERATION_FENCE_LOST`. The lease fence itself is unchanged. |
| `exactPositiveInteger` | Generation and epoch values (PostgreSQL BIGINT strings, SQLite numbers) must be exact positive safe integers. A driver-rounded or out-of-range value throws `PHOTO_PUBLICATION_INTEGER_INVALID`; it is never compared lossily. |

All steps are generators run by `inOwnershipTransaction`: synchronous on SQLite (never a Promise in a better-sqlite3 callback), awaited on PostgreSQL. Lock order is always the `photo_operations` row first, then the intent.

## Tests
- **Contract 1 suite** (`f2ContractOneOffline.test.ts`, actor `fixtures/f2c1Actor.ts`) now exercises the runtime module and tables.
  - The duplicate test protocol was removed (`t1Steps`, `transferSteps`, receipts, the test fence, `inF2c1Transaction`, `intentSchema.ts`).
  - `tests/f2c1/protocol.ts` keeps orchestration only: the W2 claim mirror (an existing operation goes through `guardedReclaimSteps`), the authorized-link resume procedure, the composed W2 T2 with an injected fence, and an adapter to the runtime fence.
  - Assertions are unchanged except for renames: `no-receipt` → `no-exit-record`, and the UNIQUE case now recovers in a fresh transaction instead of a savepoint (same expected result).
- **Step 4** (`publicationCompositionStep4.test.ts`, `f2s4/composition.ts`, `fixtures/f2s4Executor.ts`) uses the same runtime module (guarded W4 reclaim, review, fence and exit records).
- Steps 2 and 3, LIMIT 470 and the original F2 reproductions are unchanged.
- **New `photoPublicationIntentSchema.test.ts`:**
  - Migration file convention: the 0043 number, reserved 0039/0042, purely additive, DDL identical to `schema.sql`.
  - Integer exactness.
  - Per driver (SQLite via `ensureSchema`; PostgreSQL via 0043 applied onto a disposable schema migrated through 0041):
    - pre-WP1 database with existing rows → tables added, rows unchanged, re-apply idempotent
    - constraints, keys and foreign keys
    - runtime decisions (non-expiring intent blocks reclaim; transfer needs the exact exit record; stale-epoch fence lost; commit with an expired lease; exactly once)
    - out-of-range epoch fails closed
    - forward-only recovery (inert tables)
- All of these run in the required `w2-live-adoption-gate` job (`F2C1_REQUIRE_POSTGRES=1`, `F2_CAPABILITY_REQUIRE_LINUX=1`). The new suite was added to its vitest command.

## Remaining gaps (not in WP1)
- **Owner wiring.** W2 and W4 claims must use guarded reclaim. Publication must take T1 and go through the copy-owned publisher. Commits must use the intent-authorized fence.
- **Flags and rollout.**
- **Runtime executor and launcher integration**, and **runtime exit authentication**: a trusted component that calls `persistAuthenticatedExecutorExitSteps` (WP5).
- **Recovery reporting** for `authorized` and `review` intents.
- **Render topology.**

Until those land, Photo F2 stays HIGH/FAIL.
