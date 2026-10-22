# #407/#396 P2-2B3D4: all-writer fencing adoption plan

**Status: first-writer integration BLOCKED. This change is the adoption plan plus guard tests only.**

- Stacked on #409 (`feat/photo-recovery-reconciliation-p2-2b3d3`) at exactly `b61f7e8827661b686274ad3f7f41eb0a0d2ffb0c`; that branch descends from #408 `a5b8236`. Parent branches are unchanged.
- **No application source file is modified.** `PRODUCT_PHOTO_DISK_STAGING_ENABLED` stays OFF by default.
- #396, #407 and #390 stay open or blocked.

This plan reuses the #408 writer census and measurements, the #409 recovery classification and the #406 capability. It does not rediscover them.

## Readiness legend

- **READY:** can adopt the existing development capabilities without schema changes or prior adoption of another writer.
- **DEPENDENT:** a protection design exists, but it needs other writers adopted first or a durable authority in the application schema.
- **BLOCKED:** needs a new authority that is not authorized (deletion, scavenging, external-reference proof) or an owner decision.

## 14-writer matrix

Each writer is listed with:
- **Mutation boundary:** what it changes on disk and in the DB.
- **Ownership / generation today:** how it is identified, and whether anything is fenced.
- **Bypass:** how it currently avoids the #406 capability and the #408 disk budget.
- **Required protection.**
- **Reservation:** the disk-budget profile it would need.
- **Crash / retry:** what a crash or retry leaves behind.
- **Dependencies / rollout risk.**

### Writer 1: Legacy product upload — **BLOCKED**

- **Code:** `routes/products.ts` (Multer memory) → `LocalPhotoStorage.saveProductPhoto`.
- **Mutation boundary:** `writeFile` main and thumbnail into canonical (random keys), then a DB transaction (photo row + promote outbox). Compensation `rm`s on DB failure.
- **Ownership / generation today:** none (request scope only).
- **Bypass:** writes canonical directly. `writeFile` overwrites instead of using a no-overwrite publish. No budget.
- **Required protection:** retire in favour of writer 2 rather than retrofit.
- **Reservation:** n/a.
- **Crash / retry:** orphans on crash. A lost COMMIT acknowledgement can delete committed bytes.
- **Dependencies / rollout risk:** must be disabled in every running process before any capability writer is enabled. A mixed-version window loses fencing.

### Writer 2: Staged product upload (flag ON) — **DEPENDENT**

- **Code:** `productPhotoUpload.ts` + `LocalStagedProductPhotoStorage`.
- **Mutation boundary:** private ingress `input`, `wx` placeholders, `toFile`, no-overwrite `link` into canonical, then a DB transaction (row + outbox).
- **Ownership / generation today:** request directory only; no durable owner, generation or token.
- **Bypass:** the in-process 42-MiB reservation under-counts (#408). Canonical publication is not token-validated.
- **Required protection:**
  - #406 capability with a durable authority (operations, generations, bindings, seals) **in the same DB transaction** as `product_photos` + outbox;
  - a path-fed (not Buffer) capability entry point;
  - the #408 budget's `d1CapabilityProduct` profile.
- **Reservation:** ≥ 74.04 MiB in flight (path-fed), plus retained private inventory.
- **Crash / retry:** B1 retains on ambiguity (good). Capability markers retain on SIGKILL (#406).
- **Dependencies / rollout risk:**
  - **Needs an application schema migration** for the authority (not authorized);
  - writers 8, 9 and 10 must stop deleting canonical by key first;
  - private retention needs a GC protocol (#396).

### Writer 3: AI intake original upload — **DEPENDENT**

- **Code:** `aiIntakePhotoStorage.saveIntakePhoto` (+ `.ai-intake-upload-ingress` when the flag is ON).
- **Mutation boundary:** `wx` placeholder + `toFile` into the AI private root, then an `ai_intake_photos` row.
- **Ownership / generation today:** UUID storage key; no generation.
- **Bypass:** not admitted to any budget. The capability only publishes into the canonical root.
- **Required protection:** a capability variant for a second private root (intake), with its own marker namespace; budget profile (input + 1 output).
- **Reservation:** ≈ 10 + 16 MiB plus ingress.
- **Crash / retry:** zero-byte placeholders after OOM (#394/#396). The own partial output is removed on failure.
- **Dependencies / rollout risk:** writers 5 and 6 delete in the same root, so they must be adopted or disabled first. Needs the authority schema.

### Writer 4: AI deterministic finalization — **DEPENDENT**

- **Code:** `writeDeterministicProductPhoto` (default root), inside `finalizeAiIntakePhotos`.
- **Mutation boundary:** idempotent `writeFile` main and thumbnail at deterministic canonical keys; then a DB transaction (photo row + outbox); the source is retained.
- **Ownership / generation today:** deterministic `<productId>-<photoId>` keys; no generation.
- **Bypass:** writes canonical directly. A byte-identical retry is a no-op; different bytes produce a conflict error.
- **Required protection:** `prepareDeterministic` + `publish` (#406) under an authority row created in the finalization transaction.
- **Reservation:** 64.04 MiB.
- **Crash / retry:** retry-safe for identical bytes. A stale writer can overwrite (#404 counterexample) unless fenced.
- **Dependencies / rollout risk:** needs the authority schema in the intake/finalize transaction; writers 6 and 8 must not delete the canonical outputs.

### Writer 5: AI intake delete — **BLOCKED**

- **Code:** `deleteIntakePhoto` → `deleteManagedFile`.
- **Mutation boundary:** DB row delete, then `unlink` in the AI private root.
- **Ownership / generation today:** row identity only.
- **Bypass:** a deletion authority with no reference census.
- **Required protection:** a fenced, reference-aware delete protocol (#396).
- **Reservation:** n/a.
- **Crash / retry:** after a crash between the DB delete and the unlink, the file is orphaned (classified AMBIGUOUS by #409).
- **Dependencies / rollout risk:** deletion is not authorized.

### Writer 6: AI intake cleanup — **BLOCKED**

- **Code:** `aiIntakeCleanup` → `deleteManagedFile(private | canonical)`.
- **Mutation boundary:** `unlink` of private **and canonical** files after a scan.
- **Ownership / generation today:** retention policy; no generation.
- **Bypass:** holds canonical deletion authority, which contradicts retain-only.
- **Required protection:** replace with #409 classification plus operator review; there is no automatic deletion.
- **Reservation:** n/a.
- **Crash / retry:** an idempotent re-scan.
- **Dependencies / rollout risk:** must be disabled before any capability writer publishes canonical files.

### Writer 7: Outbox promotion — **DEPENDENT**

- **Code:** `ProductPhotoPromotionHandler`.
- **Mutation boundary:**
  - same root (the production configuration): existence checks + a DB status update only;
  - distinct roots: `copyFile` + `unlink`.
- **Ownership / generation today:** outbox claim (`locked_by`) only.
- **Bypass:** the distinct-root branch copies and unlinks outside the capability.
- **Required protection:** forbid distinct-root mode while capability writers are enabled. The same-root path only needs token-validated existence checks.
- **Reservation:** none (same root).
- **Crash / retry:** an idempotent retry per outbox policy.
- **Dependencies / rollout risk:** depends on writers 2 and 4 producing the files it promotes.

### Writer 8: Outbox canonical delete — **BLOCKED**

- **Code:** `ProductPhotoDeleteHandler`.
- **Mutation boundary:** `unlink` of canonical keys taken from the event payload.
- **Ownership / generation today:** outbox claim only.
- **Bypass:** key-based canonical deletion; does not know about hardlinked sealed copies.
- **Required protection:** drain or no-op historical delete events before enabling capability writers. Future deletion needs the #396 protocol.
- **Reservation:** n/a.
- **Crash / retry:** after a crash the file is gone and the DB row is deleted, which is consistent; with stale events, a newer file under the same key could be deleted.
- **Dependencies / rollout risk:** **this is the main mixed-version hazard**; deletion is not authorized.

### Writer 9: Outbox temp cleanup — **BLOCKED**

- **Code:** `ProductPhotoCleanupTempHandler`.
- **Mutation boundary:** `unlink` of temp-root keys. **In production the temp root equals the canonical root.**
- **Ownership / generation today:** outbox claim only.
- **Bypass:** deletes canonical keys whenever the roots are equal.
- **Required protection:** disable it, or make it refuse when temp root equals canonical root.
- **Reservation:** n/a.
- **Crash / retry:** idempotent.
- **Dependencies / rollout risk:** deletion is not authorized.

### Writer 10: Upload rollback deletion — **BLOCKED**

- **Code:** `products.ts` / `photoStorage.deleteProductPhoto` / `LocalStagedProductPhotoStorage`.
- **Mutation boundary:** `rm` of newly written canonical files when the DB transaction fails.
- **Ownership / generation today:** request scope.
- **Bypass:** deletes even when the commit outcome is unknown (legacy path).
- **Required protection:** retain-on-ambiguity (#406 `compensate` is retain-only).
- **Reservation:** n/a.
- **Crash / retry:** a lost COMMIT acknowledgement can remove committed bytes (legacy path).
- **Dependencies / rollout risk:** must be replaced by retain-only behaviour together with writers 1 and 2.

### Writer 11: Instagram derivatives and temporary files — **DEPENDENT**

- **Code:** `mediaPreparation.ts`.
- **Mutation boundary:** `.instagram-*.tmp` `writeFile` (`wx`), `link` (no-clobber) and `unlink` of the temp file, **all inside the canonical root**.
- **Ownership / generation today:** derivative name = recipe + source hash; in-process in-flight map.
- **Bypass:** no budget. The temporary files share the canonical root.
- **Required protection:** move temporaries to a private sibling; add a budget profile (one ≤ 8-MiB JPEG plus a temporary); derivatives are never deletable (external posts reference their URLs).
- **Reservation:** ≈ 2 × 8 MiB.
- **Crash / retry:** a crash orphans `.instagram-*.tmp` in canonical (#409 classifies it as ambiguous).
- **Dependencies / rollout risk:** depends on canonical sources from writers 2 and 4; external references make cleanup impossible to prove.

### Writer 12: Reel rendering (FFmpeg) — **DEPENDENT**

- **Code:** `reelRenderer.ts`.
- **Mutation boundary:** `.partial.mp4`, then `rename` onto the final name, plus `rm`; the root is `MEDIA_ASSET_DIR`.
- **Ownership / generation today:** media plan item ID.
- **Bypass:** `rename` **replaces** an existing final file (it is not no-overwrite). No budget.
- **Required protection:** no-overwrite publish (`link` + `EEXIST` check); a reel budget profile; a reference via `media_plan_items` (SQLite only).
- **Reservation:** output size bounded by an encoder limit (not measured here).
- **Crash / retry:** a stale `.partial` is removed on retry, so deletion happens inside its own namespace.
- **Dependencies / rollout risk:** a separate root; independent of photo writers; the PostgreSQL schema has no `media_plan_items`.

### Writer 13: Photo backup temporary files — **READY** for budget accounting only; **DEPENDENT** for fencing

- **Code:** `product-photo-backup` use cases and repository.
- **Mutation boundary:** `mkdtemp` in `os.tmpdir()`, manifest `writeFile` (`wx`), `wx` downloads, and `rm` of its own `mkdtemp` tree.
- **Ownership / generation today:** its own `mkdtemp` directory.
- **Bypass:** it reads canonical files and never mutates them. Its temporary space is not budgeted.
- **Required protection:** reserve temporary space if `os.tmpdir()` shares the persistent disk; nothing else.
- **Reservation:** sized by the manifest (sum of object sizes).
- **Crash / retry:** an orphan `mkdtemp` tree on SIGKILL, outside the media roots.
- **Dependencies / rollout risk:** independent, but its reads race with canonical deleters (writers 8 and 9).

### Writer 14: Database backup / restore — **DEPENDENT** (DB-owned; separate gate)

- **Code:** `database-backup` use cases and repository.
- **Mutation boundary:** `mkdtemp`, `wx` download, `link` into the destination (no-overwrite), `rm` of its own tree.
- **Ownership / generation today:** its own `mkdtemp` directory.
- **Bypass:** not a photo writer; uses the same disk as the photos.
- **Required protection:** the free-space floor (#408) protects it; restore governance belongs to the DB backup issues.
- **Reservation:** DB size.
- **Crash / retry:** an orphan temporary tree.
- **Dependencies / rollout risk:** outside the photo capability's scope.

**Summary:**

| Status | Writers |
| --- | --- |
| READY | 13 (budget accounting only) |
| DEPENDENT | 2, 3, 4, 7, 11, 12, 14 |
| BLOCKED | 1, 5, 6, 8, 9, 10 |

## First-writer selection and why it is blocked

The task asked for a writer that could be fenced with:
- durable ownership tokens at the actual mutation boundary;
- no-overwrite publication;
- a whole-attempt disk reservation;
- preserved DB/outbox references;
- fail-closed behaviour.

| Candidate | Why it is not adopted now |
| --- | --- |
| 2 (staged upload) / 4 (deterministic finalization) | The only writers the #406 capability can wrap (its development producers already call their real implementations). A real adoption must create the authority (operations, generations, bindings, seals) **in the same transaction** as the `product_photos` row and its outbox event, which needs new tables in the application schema. That is a schema/migration decision that is not authorized (CLAUDE.md; task boundary). The development `probe_photo_*` tables exist only in disposable test databases. Canonical deleters 8, 9 and 10 would also remain able to delete what these writers publish. |
| 13 (backup temporary files) | It never mutates media, so there is no ownership token to validate and no reference to preserve. Adopting the budget alone would not demonstrate the required fencing gates, and the #408 budget only accepts disposable roots. A development adapter for it would be test theatre, not protection. |
| 3, 11, 12 | They need new capability variants (a second private root, Instagram temporary relocation, no-overwrite reel publication), which is new design scope. |

**Decision:** no real service writer can be adopted safely under the current authority. Implementation is **BLOCKED** until the owner approves:
1. a durable photo-operation authority in the application schema (SQLite and PostgreSQL migrations);
2. disabling or draining writers 1, 6, 8, 9 and 10 (canonical deleters and the legacy uploader) before any capability writer is enabled.

The order of adoption once unblocked:
1. Authority schema.
2. Disable 6, 8, 9 and 10 (no new deletion authority).
3. Writer 4: deterministic, already idempotent, with the smallest key space.
4. Writer 2 (path-fed).
5. Writer 7 in same-root only mode.
6. Writer 3 (intake variant).
7. Writer 11 (temporary relocation).
8. Writer 12.
9. Retire writer 1.

## Guard added: `scripts/photo-writer-adoption/census.test.cjs`

This file has no dependencies and runs in CI. Its tests:
1. **Mutation census.** Every filesystem-mutation call site in `apps/api/src` (`write`/`copy`/`rename`/`unlink`/`rm`/`link`/`mkdtemp`/`toFile`/`chmod`, plus `open` with write flags) must match the per-file counts in this matrix. Adding, moving or removing a writer fails CI until the matrix is updated.
2. **No development capability in application code.** None of `developmentPhotoStorageCapability`, `developmentPhotoDiskBudget` or `developmentPhotoRecovery` may be imported by application code. The single permitted exception is #406's private-root producer in `photoStorage.ts`: a type-only import plus one lazy `require` directly after its `NODE_ENV`/flag guard, and the test asserts exactly that shape.
3. **No default-true staging flag.** No `?? "true"`, `|| "true"` or `= "true"` default exists for `PRODUCT_PHOTO_DISK_STAGING_ENABLED`.

## Disk and RAM implications (from #408 measurements)

**Disk:**
- Adopting the capability adds two sealed copies per attempt and keeps input, raw and sealed copies permanently: measured 10.7–17.2 MiB per near-limit successful upload, against 0.5–3.7 MiB today.
- In-flight reservation is ≥ 74.04 MiB path-fed or ≥ 84.05 MiB Buffer-fed.
- Without #396 private GC, any finite budget closes admission after a few uploads.

**RAM:**
- The Buffer-fed development producers copy the input (`Buffer.from`), adding ≤ 10 MiB of JS memory per attempt on top of the caller's Buffer. The path-fed adoption design avoids this.
- Native Sharp memory is unchanged (same recipe).
- #390 (24 MP / 512 MiB) remains FAILED/BLOCKED, and adoption does not improve it.

## Compatibility and rollback

- Default behaviour is unchanged: no application source is modified and no route, flag, schema or configuration changes.
- Rollback: revert the commit. That removes the plan, the guard test and its CI step.
- The census guard only fails CI when writers change. If a deliberate writer change is reviewed and approved, update the matrix and the expected counts together.
