# #396: P2-2B3D3, DB/outbox-aware photo recovery classification

**Status: cleanup BLOCKED. Delivers a design plus a read-only, development-only classifier.**

- Stacked on #408 (`feat/photo-storage-writer-integration-p2-2b3d2`) at exactly `a5b8236870507a0b60b262491d5d8256bcb1a19e`. #408, #406 and their parents are unchanged.
- `apps/api/src/services/developmentPhotoRecovery.ts` is not imported by any route, scheduler, startup hook or service default. It refuses to run unless `NODE_ENV` is test or development, `PRODUCT_PHOTO_DISK_STAGING_ENABLED=true`, and every root is a disposable `os.tmpdir()/noctella-photo-fence-*` directory.
- It never deletes, renames, quarantines or truncates anything, and never removes a marker or reservation. Its only writes:
  - an exclusive (`wx` + `fsync`) review record in its own review directory;
  - optionally, a fail-closed admission close through the caller's hook, such as `DevelopmentPhotoDiskBudget.close`.
- #396 stays OPEN. #390 stays BLOCKED.

## Authoritative reference sources

Every source is read in **one consistent read-only snapshot**:
- SQLite: one better-sqlite3 read transaction. It is synchronous, so no Promise crosses the transaction.
- PostgreSQL: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.

| Source | Columns | Root |
| --- | --- | --- |
| `product_photos` (required) | `url`, `thumbnail_url`, `filename`, `storage_key`, `thumbnail_storage_key` | canonical |
| `outbox_events` (required) | `payload` of every `product_photo.*` event in **any status**, including completed and dead-lettered (`url`, `thumbnailUrl`, `storageKey`, `thumbnailStorageKey`, `filename`) | canonical |
| `ai_intake_photos` (required) | `storage_key` | AI-intake private root |
| `order_items.product_image_url`, `categories.display_image_url`, `collections.cover_image_url` (optional) | historical URL snapshots | canonical |
| `media_plan_items.reel_asset_path` (optional; SQLite only) | basename of the rendered reel | media assets |
| `probe_photo_operations`, `probe_photo_seals` (#406 development authority) | current generation per operation; recorded seal directories | generation-private |

- A missing **required** table, an unreadable outbox payload, or any snapshot error makes the whole run `AMBIGUOUS_DB_UNAVAILABLE`.
- A missing **optional** source is recorded in `missingOptional`, never silently treated as "no references".
- External references cannot be checked from the DB, so the affected roots are never candidates:
  - published Instagram/marketplace URLs;
  - remote backup manifests;
  - links customers or marketplaces copied.

## Protocol

1. **Inventory A:** `lstat` only, no symlink following. Records dev, ino, size and mtime (ns) for each file.
2. **Authoritative reference snapshot,** as above.
3. **Inventory B.** Classification uses B. A file that differs between A and B is never a candidate.
4. **Classification.** First match wins:

| Class | Rule | Review? |
| --- | --- | --- |
| `AMBIGUOUS_UNEXPECTED_LAYOUT` | not a regular file, or unexpected private layout | yes |
| `AMBIGUOUS_DB_UNAVAILABLE` | no authoritative snapshot | yes |
| `REFERENCED` | name referenced by any source above for its root | no |
| `AMBIGUOUS_ZERO_BYTE` | zero bytes outside a generation-private tree (reserved placeholder or partial write) | yes |
| `AMBIGUOUS_UNFENCED_ROOT` | unreferenced file in the canonical, intake, media or staging roots. Legacy, Instagram, AI and HTTP writers create files **before** COMMIT, so a missing row is not proof | yes |
| `OPERATION_MARKER_RETAINED` | a `locks/<op>.lock`, or any file of an operation that has a marker (live or SIGKILL-retained) | yes |
| `AMBIGUOUS_UNKNOWN_OPERATION` | operation absent from the authority | yes |
| `AMBIGUOUS_FUTURE_GENERATION` | generation > authoritative generation (rollback/ABA) | yes |
| `REFERENCED_VIA_CANONICAL_LINK` | sealed inode shared with a canonical file | no |
| `SEALED_RECORD_RETAINED` | sealed copy referenced by a seal record | no |
| `CURRENT_GENERATION_RETAINED` | current generation: its owner may still be producing or publishing | no |
| `AMBIGUOUS_CHANGING` | superseded generation, but the file changed between A and B (late native writer) | yes |
| `UNREFERENCED_CANDIDATE` | superseded generation, unsealed, no marker, stable across A and B, authoritative snapshot (zero-byte partial outputs are flagged) | no; **reported only** |

5. **Missing referenced files.** A referenced canonical name that no longer exists (for example, removed by a legacy key-based deleter) is reported in `missingReferenced` and forces review.
6. **Retained bytes** are reported per class, counting each inode once.
7. **Review record.** The record is always written. When review is required, the caller's admission hook is invoked to fail closed. There is no reopen path.

Why only superseded private generations can be candidates:
- #406's reclaim increments the generation and revokes the old token at every protected boundary, so the old generation can never be sealed or published again.
- No age, PID, TTL or lease expiry contributes to any decision.
- A current generation is never a candidate, even if it looks idle.

## Engine differences and non-atomic states

- **Lost COMMIT acknowledgement.** Filesystem publication and DB COMMIT are not atomic. While the row is invisible, the published canonical file is `AMBIGUOUS_UNFENCED_ROOT` and review is required. Once the committed row is visible, the same bytes are `REFERENCED`. Tested on both engines.
- **SQLite.** WAL readers see the last committed state at the snapshot's first read. The collector reads every source inside that single transaction and rebuilds the snapshot from the rows it already holds.
- **PostgreSQL.** REPEATABLE READ gives one snapshot across all queries. A connection loss mid-snapshot rolls back and yields `AMBIGUOUS_DB_UNAVAILABLE`.
- **Restart.** Classification depends only on files and the DB, so it is identical after a restart. A SIGKILL-retained marker stays and forces review (tested by killing a real process inside the #406 marker section).

## Protected versus unprotected recovery surfaces

| Surface | Status |
| --- | --- |
| #406 generation-private tree (development) | Classifiable; stale-generation candidates can be identified. Cleanup **not** authorized |
| Canonical product-photo root | Reference-checked; unreferenced files always **ambiguous**, because of unfenced writers 1, 2, 4 and 11 in #408's census |
| AI-intake private root | Reference-checked against `ai_intake_photos`; unreferenced files always ambiguous (writer 3 is unfenced) |
| Media assets (reels) | Reference-checked on SQLite; PostgreSQL has no `media_plan_items` (recorded as `missingOptional`); unreferenced files ambiguous |
| Staging (HTTP and AI ingress) | Never DB-referenced; always ambiguous |
| Instagram derivatives in the canonical root | No DB reference (external posts may hold the URL); always ambiguous |
| Backups and S3 manifests | Out of scope; never a recovery source or target |

## Blockers (why cleanup is not implemented)

1. **Unfenced writers and deleters** (#408 census items 1–14) can create, link or delete files outside the capability. A snapshot cannot prove absence of an in-flight reference in any shared root.
2. **External references** (published posts, marketplace listings, backup manifests) are not in the DB.
3. **Single-volume check-then-act.** Even for private candidates, a deleting action would need to hold the operation's marker and revalidate the authority, the inode and the absence of a seal under it. That deletion authority does not exist and is not authorized.
4. **Mixed-version rollout.** Old binaries without the capability must be drained before any reconciliation acts.
5. **Owner decision** on retention and review workflow (who reviews, what evidence they need, what happens to the bytes).

## Validation

See `photo-recovery-evidence/REPORT.md`.
- **Local SQLite:** all 10 cases pass.
- **PostgreSQL:** the 9 parity cases run in CI only (the new CI step `Disposable photo recovery classification (SQLite and PostgreSQL)`, artifact `photo-recovery-<run_id>`).

## Rollback

- Revert the commit. This removes the module, `scripts/photo-recovery-reconciliation/`, the CI step and artifact, and these docs.
- No schema, migration, flag, route or production configuration is added.
- Review records exist only in disposable test roots.
