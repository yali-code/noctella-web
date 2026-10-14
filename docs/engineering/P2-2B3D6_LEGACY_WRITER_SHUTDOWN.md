# #396/#403/#407 P2-2B3D6: legacy writer shutdown gates and migration readiness

**Status:**
- **Shutdown protocol:** proven for code that calls the gate, as a development-only guard.
- **Live shutdown:** **BLOCKED** until older binaries are provably stopped and the owner authorizes it.
- **Migration:** a readiness checklist only; no migration is applied.

- Stacked on #411 (`feat/photo-ownership-schema-p2-2b3d5`) at exactly `8a030935281ddb52366cf0d5b1a0d29403b389d1`. Ancestry: #410 `6c4c2b8` ← #409 `b61f7e8` ← #408 `a5b8236`.
- New `apps/api/src/services/developmentLegacyWriterGate.ts` is development-only and not imported by any route, worker, scheduler or dispatcher; the census guard enforces this. It refuses to construct unless `NODE_ENV` is test or development, `PRODUCT_PHOTO_DISK_STAGING_ENABLED=true` and the root is a disposable `os.tmpdir()/noctella-photo-fence-*` directory.
- It never deletes, renames or quarantines media. Its only writes are its own epoch files, lease markers and lock.
- `PRODUCT_PHOTO_DISK_STAGING_ENABLED` stays OFF. #396, #403, #407 and #390 remain open or blocked.

## Gate protocol (what the guard proves)

| Element | Rule |
| --- | --- |
| Gate state | Append-only epochs (`epochs/<n>.json`, `wx` + `fsync`, never overwritten): `OPEN → DRAINING → CLOSED`. Explicit reopen to `OPEN` writes a **new** epoch. A torn or missing newest epoch → `GATE_UNAVAILABLE`, which fails closed |
| Transition | CAS on the expected epoch under an exclusive lock with a nonce; a crashed holder leaves `GATE_BUSY` until review |
| Writer lease | `enter(writer)` only while `OPEN`, recording a durable in-flight marker. `checkpoint()` immediately before **every** mutation; any epoch change → `LEGACY_WRITER_GATE_CLOSED` |
| Outbox | Delete and temp-cleanup events are **parked** (handler not run, event not acknowledged) unless `OPEN`. Promote and other events continue |
| Closure | `CLOSED` only from a `DRAINING` report for the same epoch with known outbox state, zero in-flight markers (re-read under the lock) and zero non-terminal or locked dangerous events. A forged or unknown report → `GATE_DRAIN_UNPROVEN` |

**Why no mutation can follow closure:** a writer either fails its checkpoint (the epoch changed) or already holds a marker. Closure requires zero markers, so it waits until every admitted mutation has exited. A SIGKILLed writer's marker is retained, and closure stays refused until operator review.

**Hard limitation:** code that does not call the gate (an older binary, an ad hoc script) is not stopped. A live shutdown therefore requires that every old instance is stopped first; see the readiness checklist.

## Five-writer shutdown and readiness matrix

### W1: legacy product upload

| Aspect | Detail |
| --- | --- |
| Entry points | `routes/products.ts` `legacyPhotoUpload` (flag OFF) → `services/products.ts` `uploadProductPhoto` → `LocalPhotoStorage.saveProductPhoto` (`writeFile`) → `persistUploadedProductPhoto` (locked transaction: row + promote outbox) |
| Mutation vs commit | Files **before** the commit; random keys |
| Canonical / history risk | Overwrite-capable `writeFile`; an orphan if the process dies before commit |
| Retry / rollback today | No retry. Compensation deletes on transaction failure (W10) |
| Drain condition | No `W1` lease markers; HTTP route stopped |
| Detection | Gate markers (gated code); otherwise the process inventory (old binaries) |
| Mixed-version risk | Old binary uploads directly; **must be stopped** |
| Required replacement | Staged/capability path (W2) with no-overwrite publication |
| Interrupted shutdown | Retained markers → operator review; `#409` classifies orphans as ambiguous |
| Rollback | Reopen to `OPEN` (new epoch); nothing deleted |
| Readiness gate | Route disabled in every running instance and `inflight=0` |
| Test | "in-flight legacy upload during shutdown" |

### W6: AI intake cleanup (canonical deletion)

| Aspect | Detail |
| --- | --- |
| Entry points | `services/aiIntakeCleanup.ts` `runAiIntakeCleanupForAdmin` / `…ForScheduler` → `use-cases/ai-intake-cleanup` → `deleteManagedFile(productPhotoStaticRoot, key)` |
| Mutation vs commit | Scan-based; no DB transaction around the delete |
| Canonical / history risk | Deletes canonical "orphans" by scan; misses outbox and history references (#409) |
| Retry / rollback today | Idempotent re-scan |
| Drain condition | Scheduler and admin trigger disabled; no `W6` markers |
| Detection | Gate markers; scheduler configuration |
| Mixed-version risk | Old scheduler can still delete; **must be stopped** |
| Required replacement | #409 read-only classification + operator review; no auto-delete |
| Interrupted shutdown | Retained marker → review |
| Rollback | Reopen; never re-enables canonical deletion until #396 |
| Readiness gate | Scheduler off and `inflight=0` |
| Test | Ungated baseline (deletes); "rollback" (refused while closed); SIGKILL |

### W8: outbox canonical delete

| Aspect | Detail |
| --- | --- |
| Entry points | `productPhotoOutboxDispatcher.ts` `dispatchDueProductPhotoOutboxEvents` → `ProductPhotoDeleteHandler.handle` (unlinks payload keys) |
| Mutation vs commit | After the photo row delete commits (the event comes from `deleteProductPhoto`); before the outbox acknowledgement |
| Canonical / history risk | Key-based; would delete a **newer** generation published at the same key |
| Retry / rollback today | Retried until completed or dead-lettered; `unlink` of a missing file is idempotent |
| Drain condition | No pending, processing or locked delete events (operator disposition); dispatcher parks new ones |
| Detection | `outbox_events` status / `locked_by` |
| Mixed-version risk | Old dispatcher runs the handler; **must be stopped** |
| Required replacement | Park; reference-aware delete protocol (#396) |
| Interrupted shutdown | Interrupted before acknowledgement → stays processing or locked → closure refused |
| Rollback | Reopen resumes parked events; operator decides each |
| Readiness gate | `dangerousEvents=0` with known outbox state |
| Test | "outbox worker interrupted…"; "concurrent delete vs new sealed generation"; SQLite/PostgreSQL parity |

### W9: outbox temp cleanup

| Aspect | Detail |
| --- | --- |
| Entry points | Same dispatcher → `ProductPhotoCleanupTempHandler.handle`. **In production the temp root equals the canonical root** |
| Mutation vs commit | After the producing transaction; before acknowledgement |
| Canonical / history risk | Deletes canonical keys whenever the roots are equal |
| Retry / rollback today | Idempotent |
| Drain condition | No non-terminal cleanup events |
| Detection | `outbox_events` |
| Mixed-version risk | **Must be stopped** |
| Required replacement | Refuse whenever temp root equals canonical root; park |
| Interrupted shutdown | Same as W8 |
| Rollback | Reopen |
| Readiness gate | `dangerousEvents=0` |
| Test | "rollback to OPEN deletes nothing"; parity test (`processing` + `locked_by` blocks) |

### W10: upload rollback deletion

| Aspect | Detail |
| --- | --- |
| Entry points | `persistUploadedProductPhoto` catch block (legacy `compensateOnTransactionFailure=true`) and `uploadStagedProductPhoto` abort → `storage.deleteProductPhoto` (`rm`) |
| Mutation vs commit | **After an unknown commit outcome.** A lost acknowledgement can delete a committed photo's files |
| Canonical / history risk | Deletes possibly referenced bytes |
| Retry / rollback today | None |
| Drain condition | No `W10` markers |
| Detection | Gate markers |
| Mixed-version risk | Old binary keeps deleting; **must be stopped** |
| Required replacement | Retain on ambiguity (B1 staged path already does; #406 `compensate` is retain-only) |
| Interrupted shutdown | Retained marker → review |
| Rollback | Reopen; still retain-only |
| Readiness gate | `inflight=0` and legacy path removed |
| Test | "lost COMMIT acknowledgement"; "stale writer / ABA" |

## Migration-readiness checklist (proposed P2-2B3D5 schema)

**None of the following has been executed against production or staging.**

| # | Item | Status |
| --- | --- | --- |
| 1 | SQLite and PostgreSQL compatibility | PASS in disposable databases: one portable additive DDL file; PostgreSQL BIGINT decoded exactly at the adapter boundary (#411 CI 38618252790) |
| 2 | Ordering and dependencies | The PostgreSQL migration must follow the highest applied migration in the deployed branch. This stack reaches `0038`; `origin/main` also ends at `0038` (checked 2026-10-14), while the Etsy listing-parity branches propose `0039`, so the photo migration number must be assigned after whichever lands first. Renumber at integration time. It depends only on existing tables, with no FK to `product_photos`. SQLite needs a matching `ensureSchema` additive block. **Not registered** |
| 3 | Transaction and concurrency safety | PASS (disposable): atomic finalize, CAS reclaim, unique nonces, concurrent claims (#411) |
| 4 | Old/new version compatibility | Old binaries ignore the tables, but **still mutate files**. Every W1/W6/W8/W9/W10 instance must be stopped (not just gated) before any capability writer runs |
| 5 | Writer shutdown before activation | Order: stop old instances → deploy the gated build with the flag OFF → `OPEN→DRAINING` → drain report `ready` → `CLOSED` → only then enable a development writer. **Not authorized live** |
| 6 | Backup and restoration | Take a DB backup and a canonical photo backup manifest (existing `photos:backup` / `db:backup`) immediately before migrating; verify restore (`db:restore-verify`, `photos:recovery-verify`). Never treat S3 backups as primary or delete them for recovery |
| 7 | Rollback and forward recovery | The additive migration is left in place on application rollback (old code ignores it). `down.sql` only when no operation is `preparing`, `sealed` or `review`. Forward-fix preferred; ownership rows are evidence |
| 8 | Preservation of ownership history | Generations and artifacts are append-only; no automatic pruning |
| 9 | Source and canonical integrity | No key, URL, ID or content change. Gate rollback deletes nothing (hash and inode proof in tests) |
| 10 | Outbox during migration | Promote events continue. Delete and cleanup events are parked (never acknowledged) until operator disposition |
| 11 | Deployment sequencing | (a) backup and verify; (b) migrate additively; (c) deploy the gated build, flag OFF; (d) stop old instances (Render with a disk replaces rather than overlaps; **verify for the actual service**); (e) drain and close the gate; (f) development-only writer trial on non-production data |
| 12 | Feature-OFF behaviour | Gate, budget, recovery and capability modules are unimported by the application (census); flag OFF keeps the legacy route; no default-true fallback |

## Remaining blockers

1. **Stopping old binaries cannot be proven by code.** It needs a deployment procedure the owner verifies (instance inventory, Render replace semantics), plus owner authorization.
2. **Gate wiring:** wrapping writers 1, 6, 8, 9 and 10 and the dispatcher in the real application is not done or authorized.
3. **Parked delete and cleanup events** need an operator disposition workflow (#396).
4. **Migration registration** (SQLite `ensureSchema` + numbered PostgreSQL file) needs owner authorization.
5. #396 private GC, production disk sizing and the #390 memory gate remain open.

## Development-only AI finalization integration

**Not yet.** It can begin only after:
- the gate is wired with old instances verifiably stopped (blockers 1–2);
- the ownership schema is registered for development databases (blocker 4).

The P2-2B3D5 contract already matches finalization's transaction, so no further design work is needed; the blockers are authorization and deployment.

## Validation

See `photo-legacy-gate-evidence/README.md`.

## Rollback

- Revert the commit. This removes the development gate module, its census entry, the tests, the CI step and these docs.
- No application behaviour, schema or configuration changed.
