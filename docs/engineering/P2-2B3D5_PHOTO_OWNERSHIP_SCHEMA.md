# #396/#403/#407 P2-2B3D5: durable photo-operation ownership schema and transaction contract

**Status: PROPOSED schema and contract, validated on disposable SQLite locally (PostgreSQL in CI). Not registered, not migrated, not wired.**

- Stacked on #410 (`feat/photo-writer-fencing-adoption-p2-2b3d4`) at exactly `6c4c2b8ac401d6a24d9193278b7747337363c84c`; ancestry: #409 `b61f7e8` ← #408 `a5b8236`.
- `docs/engineering/proposed-photo-ownership/{up,down}.sql` live outside `apps/api/src/db` (SQLite `ensureSchema`) and outside `postgres-migrations/`, so no application path can apply them.
- Only the disposable test harness (`scripts/photo-ownership-schema/`) applies them, to temporary SQLite files and throw-away PostgreSQL schemas.
- No application source changes. `PRODUCT_PHOTO_DISK_STAGING_ENABLED` stays OFF.
- #396, #403, #407 and #390 remain open or blocked.

## Existing boundaries this builds on

- **AI finalization** already runs one transaction per intake (`createAiIntakePhotoFinalizeTransactionCapabilityForDb.runWithLockedIntake`):
  - SQLite: one synchronous better-sqlite3 callback, where a returned Promise is rejected.
  - PostgreSQL: `SELECT … FOR UPDATE` on the intake row, then on the product row.
  - The ownership contract adds statements inside that same transaction. It does not add a second transaction boundary.
- **#404 harness:** proved claim/reclaim/fence on `probe_photo_*` tables.
- **#406 capability:** generation-private writes, seals and no-overwrite publication.
- **#409 classifier:** consumes references.

This change formalizes those probes into a schema the application could adopt.

## Proposed schema (portable SQL, additive only)

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `photo_operations` | One logical photo write: kind (`ai_finalize` or `product_upload`), subject (for example `ai_intake_photos` + id), deterministic `target_photo_id`, immutable canonical `main_key`/`thumb_key`, `input_sha256`, current `generation`/`owner`/`nonce`, `state` (`preparing → sealed → committed`, or `review`), `lease_until_ms`, `seal_id`, `committed_photo_id`, `committed_event_id`, `review_reason` | PK id; UNIQUE main_key, thumb_key, target_photo_id, (subject_type, subject_id); CHECK states/kinds; main ≠ thumb |
| `photo_operation_generations` | Append-only generation history (`active`, `superseded`, `committed`, `review`) | PK (operation, generation); **UNIQUE (operation, nonce)** prevents ABA nonce reuse |
| `photo_operation_artifacts` | Sealed private artifacts: relative path, SHA-256, sizes, exact dev/ino strings | FK (operation, generation) → generations; unique path; sizes > 0 |
| `photo_storage_roots` | Physical root identity registered once (#406) | PK |

There is deliberately **no foreign key** to `product_photos`. A later photo deletion must not cascade into, or be blocked by, ownership history. The finalize transaction enforces consistency instead, and `committed_photo_id` keeps the reference.

Existing `product_photos`, `outbox_events`, IDs, keys, URLs and payload shapes are unchanged. This is asserted by comparing column definitions before and after.

## Transaction contract

| Step | Transaction | Rule |
| --- | --- | --- |
| `claim` | one | Inserts the operation and generation 1 with `ON CONFLICT DO NOTHING`. Any conflict (same id, key, subject or target photo) returns null, so fail closed |
| `reclaim` | one | CAS: `generation = expected`, `lease_until_ms <= now`, state preparing or sealed. Increments the generation, clears the seal and supersedes the old generation. A reused nonce aborts the whole transaction |
| `seal` | one | Fenced: generation, owner, nonce, live lease, state `preparing`. Records the artifact for **this** generation; state becomes `sealed` |
| filesystem | n/a | Publish the canonical pair with no-overwrite links (#406) **after** `seal` and **before** `finalize`. A crash here leaves the operation `sealed`, and the canonical keys stay referenced by `photo_operations` |
| `finalize` | **the existing locked-intake transaction** | (1) `committed` with the photo present returns `already-committed` without writing (retry after a lost acknowledgement). (2) `committed` with the photo missing sets `review_reason=COMMITTED_PHOTO_MISSING` and never re-creates the photo. (3) `review` stays terminal. (4) Fence plus the current seal. (5) An existing `product_photos` row with the same id or keys (legacy or mixed-version writer) moves the operation to `review` without inserting anything. (6) Otherwise insert the row, insert the promote outbox event with the existing idempotency key, and set `committed`, all or nothing |

**Clock.** Tests inject `now` for determinism. A production adapter must read the DB clock inside the transaction (SQLite `unixepoch('subsec')`, PostgreSQL `clock_timestamp()`), never the caller's.

**Leases.** A lease gates reclaim only. It never authorizes deletion, and an expired lease does not revoke an in-flight filesystem section: the #406 marker still blocks it.

## Read-only recovery and retained accounting

- `photo_operations.main_key/thumb_key` is a new reference source for #409, attributed as `photo_operations.<state>:<id>`.
  - A canonical pair published before a crash, but not yet finalized, is classified `REFERENCED` (pending) instead of `AMBIGUOUS_UNFENCED_ROOT`. This is tested.
  - The #409 collector does not yet read these tables; the test merges the source through the contract adapter. Wiring it in is a follow-up.
- Retained bytes are the sum of artifact sizes for every seal that is not the committed publication (superseded or pending). They are reported, never reclaimed.

## Validation results (local Windows; PostgreSQL in CI)

| Requirement | Test | SQLite | PostgreSQL |
| --- | --- | --- | --- |
| 1 Parity | Every case below runs per engine | PASS | CI |
| 2 Atomic ownership/photo transition | Injected failure after the photo and outbox inserts rolls back everything; state stays `sealed`; retry commits once | PASS | CI |
| 3 Concurrent claim | SQLite: a held `BEGIN IMMEDIATE` makes a second connection fail `SQLITE_BUSY`, then exactly one claim wins. PostgreSQL: 4 concurrent claims yield 1 token. Key and subject uniqueness enforced | PASS | CI |
| 4 ABA / stale tokens | No reclaim during the lease; CAS on the expected generation; old token's seal and finalize → `STALE_FENCE`; nonce reuse aborts; superseded seal not current → `SEAL_NOT_CURRENT` | PASS | CI |
| 5 Lost COMMIT acknowledgement | A retry returns `already-committed` with the original event; one row, one event | PASS | CI |
| 6 SIGKILL between filesystem and DB | A real process killed after publication, before finalize. After restart: `sealed` gen 1, no row; reclaim after the lease, re-seal, finalize; canonical inode and SHA-256 unchanged; killed seal retained | PASS | n/a (#406 Linux PostgreSQL connection-loss cases) |
| 7 Active versus abandoned | Lease-gated reclaim, null while active | PASS | CI |
| 8 Outbox-only / historical | Photo deleted plus a completed delete event: retry → `review`, no resurrection; `photo_operations` still references the keys | PASS | CI |
| 9 Canonical preservation | Binding uniqueness; legacy row → `review`; published bytes preserved through crash and retry | PASS | CI |
| 10 Mixed-version legacy writer | Legacy `product_photos` row with the same key → `review`, no duplicate, no event | PASS | CI |
| 11 ENOSPC / retained budget | ENOSPC before finalize keeps `sealed` and closes the #408 budget (`reserve` → `REVIEW_REQUIRED`); retained seal bytes counted (120 B synthetic) | PASS | CI |
| 12 Failed migration / rollback | A failing DDL batch leaves no tables (transactional DDL on both engines); re-apply is idempotent; `down.sql` removes only the new tables, and application rows survive | PASS | CI |

Raw transcripts and evidence: `photo-ownership-evidence/`.

## Compatibility and rollback

- **Additive only:** four new tables and two indexes. There is no backfill, and no existing column, default or constraint changes.
- **Rollback:** `down.sql` drops the new tables. It discards ownership evidence, so it must never run while operations are `preparing`, `sealed` or `review`, or while capability writers can still run. Media is never touched.
- **Mixed versions:** an older binary ignores the tables, but it can still write canonical files and rows (writers 1, 6, 8, 9, 10). The finalize contract detects a conflicting row and moves to `review`. It cannot stop a legacy *file* write or delete. Those writers must be drained first (#410 matrix).

## Remaining blockers

1. **Owner authorization** for a real migration: SQLite `ensureSchema` additions plus a numbered PostgreSQL migration.
2. **Wiring:** the finalize statements must run inside `runWithLockedIntake`, with a DB-clock adapter, an authority adapter for the #406 capability over these tables, and the #409 collector reading `photo_operations`.
3. Canonical deleters 6, 8, 9 and 10 and the legacy uploader (1) must be disabled or drained first.
4. **PostgreSQL results** for this suite come from CI only. Linux SIGKILL for this contract is not separately run.
5. #396 private GC, production disk sizing, and #390 memory remain open.

## AI finalization eligibility

AI deterministic finalization (writer 4) becomes **eligible for a later development-only integration** once owner decisions 1 and 3 are in place and CI confirms PostgreSQL parity. The reasons:
- its transaction boundary already exists;
- its keys and photo IDs are deterministic;
- its retry semantics map one-to-one onto `already-committed` and `review`.

Until then it remains **BLOCKED**.
