# F2 closure Stage 1 — release packaging and staging acceptance preparation (#472)

- **Branch:** `release/f2-closure-stage1-packaging`, stacked on the integration branch `fix/stage5-f2-capability-fenced-publication` @ `24a16b8e2043fd0f35a0f4e28eee7cee614ae42f` (Draft PR #471; its post-merge Photo Master CI run 39229870270 had 11/11 jobs succeed).
- **Production references** (last verified releases):
  - API `f9a61bf5a79e2cf182c04b5434c61bbe32fcfb32`
  - Admin `23406f7a148a58c3567011dc3e3ce45fca4d2dbf`

  Re-verify both against the live Render deploy before any release.
- **F2 status:** NOT deployed, NOT activated, NOT closed. F2 closure 0/4. Overall engineering 4/12.

## 1. Release baseline (evidence)
| Fact | Evidence |
| --- | --- |
| Production = old `main` `1994f50` + the 6 isolated Etsy Phase 1 commits (`69d1533` → `23406f7`) | `git log 1994f50..23406f7`; the API ref `f9a61bf` is an ancestor of the Admin ref `23406f7` |
| #471 = current `main` (`7df99ba`, which contains `1994f50`) + 185 FAZ A / F2 commits | `git rev-list --count origin/main..24a16b8` = 185; `24a16b8..origin/main` = 0 |
| Neither production ref is an ancestor of #471 | `git merge-base --is-ancestor` fails for both; merge base `1994f50` |
| F2 runtime dependencies exist only in the FAZ A / F2 stack | Photo-operation authority (0040/0041), fenced W2/W4 owners and the fencing switch are absent from `main` and from production; `main..#471` touches 820 files |
| `main` changes since `1994f50` that are not yet in production | 136 files, +9,180 lines (merged, never deployed) |
| **#471 lacks the released Etsy functionality** | no `0039_etsy_listing_form_parity.sql`, no Etsy listing form, no `EtsyMediaPreview` |
| Composition conflicts (read-only `git merge-tree --write-tree 24a16b8 23406f7`) | exactly one: `apps/admin/src/app/products/[id]/photos/page.tsx`, where the released Etsy media preview + reload button meets #424's stable Idempotency-Key change. `schema.sql`, `products.ts` and `ci.yml` auto-merge. 0039 sorts before 0040; 0042 stays unused |

**Smallest coherent candidate:** #471 + the 6 Etsy release commits, with the one Admin conflict resolved.
- The FAZ A / F2 stack cannot be pruned: the F2 runtime is built on it.
- The candidate necessarily also ships the 136 undeployed `main` files, so their own acceptance must be confirmed.

**BLOCKER (composition):** building that candidate requires an integration merge of `23406f7` into the F2 stack. That merge is not authorized in this task. Until it is done and accepted, #471 alone is **not** releasable: it would remove released Etsy listing and media-preview features, while production data already carries the 0039 columns.

The upgrade path itself is safe for data (§3). Everything else in this package is independent of that merge.

## 2. Trusted launcher packaging (implemented)
- **Entry point:** `apps/api/scripts/build-landlock-launcher.mjs`, run as `npm run build:launcher -w apps/api`.
  - Source: the reviewed `scripts/photo-publication-capability/landlock-worker.c`, pinned sha256 `ad1d58ec71b28696711d8808bc011eb0ba1fe94984cdf3d7e2947ce5bfe4e47a`, the same source used by the Render probe. A test pins it.
  - Flags: `-std=c11 -Wall -Wextra -Werror -O2`.
  - Output: `apps/api/dist/bin/landlock-worker` (mode 0755, atomic rename) plus `landlock-worker.provenance.json` (source and binary sha256, sizes, os/arch/`uname -m`, compiler command, version and flags).
  - No sudo, no installs, no permission changes outside the output directory.
  - Off Linux, without a compiler, without `linux/landlock.h`, or on compilation failure it prints `LAUNCHER_BUILD_FAILED <reason>` and exits 1, with no binary. There is no fallback.
- **Location:** the application build tree (`apps/api/dist/bin`). This is outside `/var/data` (customer media, private generation roots, job roots, publication staging) and outside every worker-writable directory.
  - A confined worker cannot write it: Landlock allows writes only beneath its generation and job directories.
  - The API process itself is trusted.
- **Runtime path:** `PHOTO_PREPARATION_LAUNCHER` must be **absolute** (`photoPreparationConfinementConfig`). With `startCommand: node apps/api/dist/index.js` run from the Render checkout, the path is `<checkout>/apps/api/dist/bin/landlock-worker`. Render's native checkout is conventionally `/opt/render/project/src`; confirm it read-only with `pwd` in the service shell before setting the variable.
- **Provenance check:** `photos:release-preflight` (`launcher.provenance`) passes only when the configured binary matches its provenance record **and** was built from the reviewed source in the deployed checkout. Hashes are recorded per build and are not assumed equal across hosts or compilers.
- **CI:** both Photo Master jobs that used a raw `cc` call now build through this entry point, so every confinement test runs the packaged binary.

### Proposed Render changes (NOT applied)
1. Build command: append `&& npm run build:launcher -w apps/api`, giving `npm ci --include=dev && npm run build -w packages/shared && npm run build -w apps/api && npm run build:launcher -w apps/api`.
   - Risk: if the Render build image lacks a compiler, the whole deploy fails, including Etsy-only deploys.
   - The probe compiled successfully in the runtime shell. The build image is assumed to be the same family, but this is **unverified**.
2. Environment, set only at activation time:
   - `PRODUCT_PHOTO_DISK_STAGING_ENABLED=true` (the W2 route requires it)
   - `PHOTO_PREPARATION_CONFINEMENT=required`
   - `PHOTO_PREPARATION_LAUNCHER=<checkout>/apps/api/dist/bin/landlock-worker`
   - `PHOTO_OWNERSHIP_FENCING_ENABLED=true` **last**, after §3 quiescence.

   Until activation: fencing unset or `false`; the launcher variables may be pre-set (unused with fencing OFF).
3. No other service, disk or plan changes.

## 3. Migration, backup and rollback
**What startup actually does.** Production runs SQLite (`DATABASE_DRIVER=sqlite`; re-verify read-only without printing the URL). `runtime.ts` calls `ensureSchema`, which executes `dist/db/schema.sql` (`CREATE … IF NOT EXISTS`) plus the additive column steps on **every start**. The F2 tables (0040/0041/0043/0044 equivalents) are therefore created automatically by the first start of the new code. There is no separate migration command, and nothing is dropped or rewritten. PostgreSQL migration files are not applied by deploy.

**PostgreSQL (supported driver; not production):** `0039` (released Etsy) → `0040` → `0041` → `0043` → `0044`, all forward-only. `0042` (W11) is never applied; W11 stays dormant.

**Verified on disposable databases** (`tests/f2ReleaseCompatibility.test.ts`; Linux PostgreSQL case in CI). On top of the released Etsy shape:
- the candidate starts without error;
- every released product and Etsy column value is preserved byte-for-byte;
- the F2 tables are created;
- restart is idempotent;
- `foreign_key_check` and `integrity_check` are clean;
- on PostgreSQL, 0040–0044 apply after the released 0039 and re-apply idempotently, and 0042's table is absent.

The SQLite price-rebuild path (`INSERT … SELECT *` with a fixed column list) runs only on a DB whose `price_eur` is still `NOT NULL`. Production passed that step under the released code. **The integration candidate must keep the released Etsy column list in that rebuild** (it does in `23406f7`); this is a review point for the integration merge.

**Prerequisites before the first candidate deploy (fencing OFF):**
1. `npm run db:backup -w apps/api` and `npm run photos:backup -w apps/api`. Both **write** backups to the configured remote storage.
2. `npm run db:restore-verify -w apps/api`, which **writes** a temporary restored copy for verification. Record the hashes.
3. Single instance (one verified). Render deploys start the new instance before stopping the old one. That overlap is harmless while fencing is OFF.

**Activation (fencing ON) quiescence:** old and new code must never overlap with fencing ON, because older code would still link worker inodes.
- Turn fencing ON only through a restart in which the old instance has terminated (for example suspend/resume).
- Confirm in the Render event log that exactly one instance runs.
- Drain the outbox first (existing fencing runbook).

**Rollback:**
1. Turn fencing OFF.
2. Run `photos:publication-intents`. It must report **no `authorized` intents**. Resolve any that remain first: let the executor finish, or attest a verified termination and retry. Older code ignores intents and could reclaim after lease expiry.
3. Only then deploy older code.

Never drop or truncate `photo_operations*`, `photo_w2_upload_intents`, `photo_publication_intents`, `photo_executor_exit_records` or `photo_publication_copies` while they hold rows. Older code ignores these extra tables.

**Command write-effect classification:**
| Command | Effect |
| --- | --- |
| `photos:release-preflight` | **Read-only.** Stats paths, reads migration and provenance files, hashes the launcher. Creates nothing |
| `photos:publication-intents` (default) | **Read-only DB** report |
| `photos:publication-intents -- --attest-exit …` | **Writes** one exit record (operator attestation) |
| `photos:operations-report` | Read-only DB report |
| Any W2 or W4 request with fencing ON (readiness `assertPhotoPublicationReady`) | **Creates directories** if missing: canonical root, `.product-photo-operations`, `.product-photo-publication` (0700). It is **not** read-only |
| `db:backup`, `photos:backup`, `db:restore-verify` | **Write** backup and verification artifacts |
| `npm run build:launcher -w apps/api` | **Writes** `apps/api/dist/bin/*` only |

## 4. Staging acceptance package (prepared, NOT executed)
No suitable isolated F2 staging environment is verified. `render.yaml` describes an RC staging service, but its existence, data and isolation are unknown.

**Proposed disposable environment (owner review):**
- **Service:** one Render web service `noctella-f2-acceptance-api`. Native Node, Starter plan, one instance, the candidate commit, a 1 GB disk at `/var/data`, `DATABASE_DRIVER=sqlite`, `DATABASE_URL=/var/data/noctella.sqlite`, `PRODUCT_PHOTO_DIR=/var/data/product-photos`.
- **Configuration:**
  - fresh secrets generated for staging only;
  - no production database, disk, backup bucket, marketplace, Instagram, Stripe or AI credentials (unset, or provider calls disabled);
  - no custom production domain;
  - the build command from §2.
- **Data:** an empty database seeded with one admin user and synthetic products. Only synthetic images: generated JPEGs including 24 MP images, never customer photos.
- **Cost basis:** one Starter web instance plus 1 GB persistent disk, per Render's current published pricing. Verify before provisioning; no paid infrastructure is created by this task.
- **Teardown:** delete the service and its disk in Render. No shared resources exist to clean up.

**Steps (operator, with `$API`, an admin session cookie, and the Admin origin for CSRF):**
1. **Preflight:** `npm run photos:release-preflight -w apps/api`. Expect:
   - `migrations.0040/41/43/44`, `launcher.provenance`, `flag.preparation-confinement` and `publication.exit-authentication` PASS;
   - `storage.*` PASS;
   - MANUAL steps listed.
2. **Missing confinement refusal:** set `PHOTO_PREPARATION_LAUNCHER` to a non-existent absolute path and restart.
   - `POST $API/api/products/<id>/photos` returns **503 `PHOTO_PUBLICATION_NOT_READY`**.
   - No new files appear under `/var/data/product-photos`.
   - Restore the variable afterwards.
3. **W2 upload (protected mode):** `curl -X POST $API/api/products/<id>/photos -H "Idempotency-Key: <22+ chars>" -F photo=@synthetic.jpg -b <session>`. Expect 201. Then check:
   - `photos:operations-report` shows the operation committed;
   - `photos:publication-intents` shows no authorized intent;
   - the canonical files exist with `nlink 1`.
4. **Lost-acknowledgement retry:** repeat step 3 with the **same** key. Expect the same photo id, and unchanged counts of photos, outbox events and files.
5. **W4 finalization:** create an AI intake, stage two synthetic photos, apply it, then `POST $API/api/ai-product-intakes/<id>/finalize-photos`. Expect 200, the intake `finalized`, and two photos. Repeat the call: no duplicates.
6. **Live-executor refusal:** start a large (24 MP) upload, and while it runs send the same key again. Expect **409 `PHOTO_OPERATION_IN_PROGRESS`**. While it runs, `photos:publication-intents -- --attest-exit …` for that executor returns `refused: …still running…`.
7. **Controlled restart and recovery:** this needs an intent left authorized across a restart.
   - Restart the service while a 24 MP upload is between T1 and commit.
   - After the restart, `photos:publication-intents` shows the intent with `resumable: false` (another PID namespace).
   - A retry returns 409 (BLOCKED).
   - Attest with the exact `--operation/--epoch/--executor` from the report, plus `--evidence "<Render restart event id/time>"`.
   - The retry then commits once (epoch 2), with no duplicates.
   - **Determinism limit:** no fault hook exists in production code. Hitting the T1→commit window by restart timing is probabilistic; repeat until the report shows an authorized intent, or accept a staging-only fault hook (owner decision, §5).
8. **Resources and disk in protected mode:**
   - During steps 3, 5 and 6, sample `/proc/meminfo`, the API RSS and the confined worker RSS (`ps -o rss,cmd`) every 250 ms. A 24 MP W2 upload and a 2-photo W4 finalization must complete on the plan without OOM.
   - Record peak RSS and the transient staging bytes. The transient copy is one per artifact, removed after commit: check `du -s /var/data/.product-photo-publication` is ~0 afterwards.
   - A fencing-OFF benchmark or a BLOCKED dry run does **not** count.
9. Teardown.

Pass criteria: every expectation above. Results are recorded as staging evidence. Local tests and CI are **not** staging acceptance.

## 5. Daily-use effects with fencing ON (NOT accepted by the owner)
| Function | Effect | Follow-up options (owner decision) |
| --- | --- | --- |
| Instagram prepare-image (live) | Refused (retryable `processing`); publishing needs a prepared asset | (a) adopt W11 under publication authority, which needs 0042 approval; (b) move Instagram derivatives to a separate non-canonical root and serve them separately |
| Canonical photo deletion (W8), AI-cleanup canonical deletion (W6) | Refused and dead-lettered; files accumulate on the 1 GB disk | (a) a deletion design under authority: delete only keys whose operation is committed and whose photo row is gone, inside the intent lock; (b) operator-reviewed periodic cleanup |
| ERP photo upload `POST /api/erp/products/:id/photos/upload` and the legacy upload route | Refused (503), because they use the W1 legacy writer | Route ERP uploads through the W2 owner (Idempotency-Key semantics needed) |
| Cross-instance executor loss (any restart/deploy during publication) | BLOCKED until operator attestation with evidence | (a) accept attestation; (b) a platform-provided instance-termination signal; (c) drain uploads before planned restarts |
| Deterministic restart acceptance | No fault hook in production code | A staging-only, env-gated delay hook (needs review because it ships in production code) |

None of these is marked complete; W11/0042 is not activated.

## 6. Copilot independent review brief
Review `release/f2-closure-stage1-packaging` against base `24a16b8e`. Focus on:
1. **Launcher provenance:**
   - `build-landlock-launcher.mjs` compiles exactly the reviewed source with the pinned flags, writes only `dist/bin`, never falls back, and fails clearly;
   - the preflight `launcher.provenance` check cannot pass for a tampered binary or a different source;
   - the CI gates now use the packaged build.
2. **Baseline compatibility:**
   - confirm the composition finding (#471 lacks Etsy 0039 / listing form / media preview; one Admin conflict);
   - check that `f2ReleaseCompatibility.test.ts` faithfully reproduces the released schema (fixture copied from `23406f7`);
   - check the SQLite price-rebuild column-list risk for the integration merge.
3. **Migrations:** 0039 → 0040 → 0041 → 0043 → 0044 ordering, 0042 unused, startup `ensureSchema` semantics, no destructive SQL.
4. **Rollback:** the intent-resolution precondition, no dropping of state tables, fencing OFF first.
5. **Staging isolation:** no production credentials or data; synthetic images only; teardown; cost basis.
6. **Write-effect classification** of each command.

No independent review has occurred yet.
