# Stage 5 F2 — Contract 1 offline proof (W2) — #472

Baseline: `0724521a3b3cb1d740d74d80d7c56aa9ed1a5005` (PR #471 head). Branch: `test/stage5-f2-contract1-offline`. Scope authorized by the owner for #472: a bounded test/docs/workflow package only. It does **not** select the production contract, accept indefinite production blocking, or authorize runtime integration. No `apps/api/src` change, no runtime schema or migration (including 0042), no `products.ts` seam. No AGENTS.md or LOOP.md exists in this baseline.

## What is proved and what is not

| Property | Status |
| --- | --- |
| Cooperative-worker ordering between reclaim and canonical-name creation; exactly-once commit; crash recovery | **PROVED OFFLINE on SQLite only** (see Evidence). PostgreSQL: **NOT EXECUTED locally**; required CI gate prepared, not run. |
| Capability enforcement (a non-cooperative worker cannot link) | **NOT PROVED** — every actor keeps filesystem and DB write access |
| Byte immutability (writable private hardlink alias, #470 LIMIT test) | **NOT PROVED** — the intent binds the inode, not its future bytes |
| Production availability | **NOT ACCEPTED** — S2b/S3b demonstrate indefinite BLOCKED by design |
| Runtime Photo F2 | **HIGH / FAIL** — both unwrapped reproductions retained unchanged |
| Official progress | **4/12** |

A test-only replacement fence proves the proposed protocol; it does not mean the production fence is fixed.

## Protocol (test-only, `apps/api/tests/f2c1/`)

- **Disposable DDL** (`intentSchema.ts`): `f2c1_publication_intents` (PK `operation_id`; UNIQUE `seal_id`, UNIQUE `executor_token`; states `authorized | committed | review`) and `f2c1_executor_exit_receipts` (PK `(operation_id, executor_epoch)`). `photo_operations` and its CHECK constraint are untouched.
- **Shared synchronization boundary**: T1 and guarded reclaim both take the `photo_operations` row lock (PostgreSQL `FOR UPDATE`; SQLite `BEGIN IMMEDIATE`) **before** reading the intent. Guarded reclaim returns `in-progress` for an `authorized` intent, otherwise calls the unchanged real `claimExistingOperation` in the same transaction.
- **T1** requires the current `generation/owner/nonce`, `state='sealed'`, the `seal_id` and a live DB-clock lease; it copies the sealed identity and inserts the intent at epoch 1 under a `SAVEPOINT`. A unique violation is handled with `ROLLBACK TO SAVEPOINT` before any further query; nothing runs inside an aborted transaction.
- **Executor authority** = operation, generation, owner, nonce, seal, epoch, executor token and trusted-parent actor id. A lost-acknowledgement retry regains authority only with the same token **and** actor id. **Transfer** (epoch n→n+1) requires a receipt written by the trusted parent after it observed the exact epoch-n child exit and, on PostgreSQL, after no backend remains for that actor's `application_name`; it is an epoch CAS under the row lock.
- **Intent-authorized T2** (test-only): the real commit predicates with `lease_until_ms > now` replaced by an `EXISTS` on the authorized intent binding the full authority tuple, plus `intent → committed` (exactly one row). The lease is neither read nor renewed. T2 is composed only from exported runtime pieces (product row lock, photo list, photo+outbox writer); SQLite uses `BEGIN IMMEDIATE` (runtime uses the drizzle default) for cross-process determinism.
- **Resume procedure**: per artifact, keep a canonical name already holding the intent's exact inode; link a missing name only from a private file that still matches the intent; anything else is review. Never overwrites or deletes.
- **Observation** (`f2c1LinkObserver.cjs`): records every link attempt and always proceeds; it never waits, authorizes or denies. Authorization is validated post hoc per actor program order (`trace.ts`); cross-actor conclusions use only commit → reply → next-command barrier chains.

## Evidence (local, Windows 11, Node 24.18.0)

Command: `npx vitest run tests/f2ContractOneOffline.test.ts tests/w2FencedOwnerRecovery.test.ts tests/ownedPhotoArtifactProof.test.ts` (apps/api).

- SQLite, real child processes: C0, C1, C2/P2, P1, S1, S2, S2b, S3, S3b, S3c, S4, S4b, S4c, S5, S6, S7, S8, UNIQUE — **18/18 passed**.
- PostgreSQL: all 18 cases **skipped** — no `POSTGRES_TEST_DATABASE_URL` and no running Docker daemon locally. Not counted as evidence.
- Existing unwrapped reproductions `REPRO F2 SECURITY FAIL` (w2FencedOwnerRecovery) and `VULNERABILITY REPRODUCED F2` (ownedPhotoArtifactProof, both kinds) executed on SQLite and still reproduce — security FAIL, not PASS.

## Required CI gate (prepared, not dispatched)

`photo-master-stage1-4.yml` `w2-live-adoption-gate`: `F2C1_REQUIRE_POSTGRES='1'` makes the guard test fail unless PostgreSQL is configured, so the 18 PostgreSQL cases cannot silently skip; the suite is appended to the required run command; `fix/stage5-f2-capability-fenced-publication` is added to the trigger branches so a stacked PR onto #471 runs it. Linux execution is required before any both-driver claim.
