# Generation-fenced photo operations (W2 + W4): operator runbook and release preparation (#424 FAZ A)

## Current operator guidance (21 October 2026)

**Sections 1–4 below are historical design evidence, not current operating instructions.** They describe the pre-publication-intent implementation. Do not use their lease-only recovery table, SQL example, publication sequence or release blockers to operate the accepted F2 revision.

Use [F2 release package §3](../release/F2_CLOSURE_STAGE1_RELEASE_PACKAGE.md#3-migration-backup-and-rollback) for the current backup, quiescence, recovery and rollback procedure, and [§7.1](../release/F2_CLOSURE_STAGE1_RELEASE_PACKAGE.md#71-stage-4-production-verification-enablement-and-acceptance-20-october-2026) for the latest recorded acceptance. The [runtime remediation §7](STAGE5_F2_RUNTIME_REMEDIATION.md#7-remaining-gaps-explicit) states the remaining limits. These are local records, not a fresh live-state check.

The latest closure record reports **F2 CLOSED, 4/4; overall engineering 5/12**, with production technical acceptance on `14f17469ed43fec4e3035d08612ea3b69cf849c3`. Normal use remains paused by owner decision until 12/12; this document does not authorize resumption or any target action.

**Rollback order:** stop admission and quiesce writers. Keep protected code running with fencing ON while resolving every `authorized` publication intent through the existing recovery procedure. Cross-instance executor loss requires genuine termination evidence and exact exit attestation; elapsed leases alone do not establish safe recovery. If termination cannot be established, or W4's Product precheck prevents an authorized intent from resuming, STOP rollback. Before disabling fencing, require zero `authorized` intents and zero `preparing`, `sealed` or `review` operations, regardless of lease state. Only then may an authorized rollback disable fencing or downgrade code. Never drop or truncate authority/evidence tables or delete private/staging evidence directories. Follow §3 for the complete procedure.

Historical status at authoring: **prepared, not executed**; the statements below do not supersede the later closure record.

## 1. What fencing ON does

| Writer | Behaviour with fencing ON |
| --- | --- |
| W2 product upload (`POST /api/products/:id/photos`, disk staging) | `services/w2FencedProductPhotoOwner.ts`: operation `product_upload`, subject `w2_request:<token>` (client `Idempotency-Key`, or server-generated) |
| W4 AI-intake finalization | `services/w4FencedFinalizationOwner.ts`: one operation `ai_finalize` per staged photo, subject `ai_intake_photo:<staged id>` |
| Both | `services/photoOperationAuthority.ts`, then the generation CAS (`photoOperationCommitFence.ts`) inside the photo + outbox (+ intake) transaction |
| W1, W6–W11 | unchanged refusals (`photoOwnershipFencing.ts`) |

Operation sequence:
1. Claim (generation 1, or reclaim generation + 1 after the lease expires; database time).
2. Prepare into `<parent of PRODUCT_PHOTO_DIR>/.product-photo-operations/<operation>/<generation>/` (0700, never
   served).
3. Seal: hashes and inode identity in `photo_operation_artifacts`.
4. Verify, then `link()` to the deterministic canonical keys. Nothing is ever replaced.
5. Commit in the same transaction as the database effects.

## 2. Operator procedures

**List operations needing attention (read-only):** `listPhotoOperationsRequiringRecovery(db)`, or the equivalent
SQL:

```sql
SELECT id, kind, subject_type, subject_id, generation, state, main_key, thumb_key, seal_id, review_reason
FROM photo_operations
WHERE state = 'review' OR (state IN ('preparing','sealed') AND lease_until_ms <= <now ms>)
ORDER BY created_ms;
```

| State | Meaning | Action |
| --- | --- | --- |
| `preparing`, lease expired | crashed before sealing; private files may exist; no canonical bytes | W2: the client retries with the same `Idempotency-Key`. W4: retry finalization. Both reclaim automatically. Without a key (W2 server-generated token), leave it for the operator; never delete |
| `sealed`, lease expired | crashed after sealing; canonical keys may already be published (identical to the seal) | retry as above: reclaim, re-prepare, verify identical bytes, commit |
| `review` | `input rejected: …`, `canonical key exists with different bytes`, `published inode differs from the seal`, or a changed source | manual investigation. **Never** delete canonical files or private generation directories; compare the sealed hashes in `photo_operation_artifacts` |
| `committed` | done; `committed_photo_id`, `committed_event_id` | none; private names are unlinked after commit |

**Never:**
- delete `.product-photo-operations/`;
- delete canonical keys of non-committed operations;
- edit `photo_operations` rows by hand;
- bulk-retry `review` items.

## 3. Release preparation (requires separate owner authorization)

1. **Stale-instance draining.** Fencing assumes no pre-fencing binary is still running. Confirm in Render that the
   previous instance stopped before the new one started, and that no worker or cron service can reach
   `PRODUCT_PHOTO_DIR`. Unknown instances mean STOP.
2. **Migration sequencing.** 0040 (ownership tables) and 0041 (W2 intents) are additive. SQLite creates them via
   `ensureSchema` at startup, so every deploy is a schema change. PostgreSQL applies them after `main`'s latest
   migration. Resolve the Etsy 0039 / photo 0040 ordering on `main`; never renumber an applied file. Back up first
   (`db:backup`, `photos:backup`).
3. **Rollback limitations.**
   - **Superseded:** use the current rollback order above and release package §3. The earlier advice to disable fencing while unfinished operations remain, or to drop ownership tables after a rollback check, is not valid for the accepted F2 revision. Preserve all authority state and evidence.
4. **Storage roots.**
   - `.product-photo-operations/` must be on the same filesystem as `PRODUCT_PHOTO_DIR`; `link()` fails closed on
     EXDEV.
   - Capacity planning must count generation directories: names only after commit, real bytes while
     non-committed.
   - Retention of uncommitted generation directories is an owner decision; nothing reclaims them automatically.
5. **Raw originals and backups.**
   - W4 consumes private staged sources, original-source keys included (W3 flag, separately fenced to
     test/development).
   - Whether private staging and generation directories join backups, and their retention, are owner decisions.
     The design (#418) recommends keeping staging out of backups.
6. **Staging acceptance checklist.**
   1. Deploy with fencing OFF and verify unchanged W2/W4.
   2. Enable fencing; run a W2 upload with an `Idempotency-Key`, plus an identical retry and a conflicting retry.
   3. W4 finalization of a two-photo intake, then a retry.
   4. Kill the process during an upload and a finalization, then recover by retry.
   5. Check the recovery listing.
   6. Disable fencing and verify mixed reads.
   7. Linux memory gate (see open blockers).

## 4. Open blockers (do not activate)

- **W11 Instagram preparation is not adopted.** It still refuses under fencing, so the unchanged 24 MP 8-operation
  workload cannot run with fencing ON; fencing-OFF 24 MP evidence remains the CI gate.
  - Exact blocker: 0040 photo_operations cannot represent a W11 derivative. Its kind CHECK allows only
    ai_finalize/product_upload, it requires a unique target photo id and distinct main/thumb keys, and artifacts
    and the commit fence are bound to a photo row and outbox event; W11 has one content-addressed key and no rows.
  - Reviewed, tested, inactive patch: docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal
    (additive tables, not created by any startup path) and services/w11FencedInstagramDerivativeOwner.ts (not
    imported by production code).
  - Wiring it requires owner approval of that schema and of migration numbering, and then switching
    mediaPreparation.ts to the owner under fencing.
- **W1 legacy upload, W6–W10 deleters and outbox handlers stay refused** under fencing (by design). Operating with
  fencing ON pauses those paths.
- **Owner decisions:**
  - client `Idempotency-Key` adoption in the admin app;
  - the fixed single-tenant intent scope;
  - retention of generation directories and raw originals;
  - backup scope;
  - Render single-instance confirmation;
  - migration numbering.
