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

**Composition:** the packaging branch alone, like #471, is **not** releasable: it would remove released Etsy listing and media-preview features, while production data already carries the 0039 columns. The owner-authorized composed candidate `release/f2-stage1-candidate` merges `23406f7` (incl. `f9a61bf`) into this packaging work. Its one Admin conflict is resolved keeping both behaviours, and it is the release-candidate review boundary.

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

**Render platform facts (official documentation, retrieved for this package):**
- [Persistent Disks](https://render.com/docs/disks):
  - "Adding a disk to a service prevents zero-downtime deploys."
  - "When you redeploy your service, Render stops the existing instance _before_ bringing up the new instance. This instance swap takes a few seconds, during which _your service is unavailable_."
  - "A persistent disk is accessible by only a single service instance, and only at runtime."
  - "You can't scale a service to multiple instances if it has a disk attached."
  - "You can't access a service's disk from a one-off job …"
  - "Render automatically creates a snapshot of your persistent disk once every 24 hours."
- [Deploys](https://render.com/docs/deploys):
  - "Render triggers a shutdown of the current instance by sending your application a SIGTERM signal." If the process doesn't exit within the shutdown delay (default 30 seconds), Render sends SIGKILL.
  - "You can't customize the shutdown delay for a service with a persistent disk."
- **Not documented, so it needs target verification:**
  - the ordering for **manual restarts** (as opposed to deploys);
  - that the production service in fact runs with the disk attached and on the documented deploy path;
  - the build image's toolchain;
  - the checkout path;
  - that the Render shell runs inside the service container (cgroup and `/proc` view).

  A single configured instance does **not** by itself prove no-overlap. Verification is read-only: the Render event log and service logs of one deploy must show the old instance's shutdown (SIGTERM/exit) completing **before** the new instance's first start log line.

**Prerequisites before the first candidate deploy (fencing stays OFF):**
1. `npm run db:backup -w apps/api` and `npm run photos:backup -w apps/api`. These **write** backups to the configured remote storage.
2. `npm run db:restore-verify -w apps/api`, which **writes** a temporary restored copy. Record the hashes.
3. Note the latest Render disk snapshot time.
4. The first start of the new code runs `ensureSchema`, which **creates** the F2 tables (§3, top). No photo directories are created while fencing is OFF.

**Quiescence and activation sequence (prepared; not executed):**
1. Deploy the candidate with fencing OFF and the launcher variables set (unused while OFF). Verify the deploy ordering in the logs as above.
2. Run `photos:release-preflight`, which is read-only:
   - FAIL for `flag.preparation-confinement` is expected while fencing is OFF only if the launcher variables are missing;
   - `launcher.provenance` must PASS.
3. **Stop admission of new photo work.** Announce a maintenance window and stop using the admin photo upload, AI finalization, Instagram preparation and ERP photo upload.
4. **Quiesce existing writers.**
   - Wait for in-flight requests to finish.
   - Drain the outbox: `photos:operations-report` shows no `preparing`/`sealed` operations with a live lease, and the outbox has no pending photo promote/delete events.
5. Set `PHOTO_OWNERSHIP_FENCING_ENABLED=true` and `PRODUCT_PHOTO_DISK_STAGING_ENABLED=true`. Render applies environment changes by redeploying; the disk service stops the old instance first. Verify ordering in the logs again.
6. First protected request:
   - readiness **creates** `/var/data/.product-photo-operations` and `/var/data/.product-photo-publication` (mode 0700) when missing;
   - `photos:release-preflight` then reports `storage.*` PASS.
7. Resume admission.

**Rollback (strict order):**
1. **Stop admission** of new photo-writing work (as in activation step 3) and **quiesce** in-flight requests.
2. **With the protected code still running and fencing still ON**, run `photos:publication-intents`, which is read-only. For every `authorized` intent:
   - **Executor alive or resumable** (`resumable: true`): retry its request (same Idempotency-Key and same file, or re-run the W4 finalization) so the protected code commits it or moves it to review.
   - **Executor lost on a previous instance** (`blockedReason` set): attest **only** with genuine termination evidence (the Render event/instance record showing that instance stopped), using the exact `--operation/--epoch/--executor` from the report. Then retry.
   - **Termination cannot be established:** the intent stays BLOCKED, and rollback **stops here**.
3. Verify `photos:publication-intents` shows **zero `authorized` intents** and `photos:operations-report` shows no live `preparing`/`sealed` operations.
4. **Only then** may fencing be disabled. With fencing OFF, these legacy writers become reachable again:
   - W1 legacy and ERP uploads;
   - the W2 legacy path (when `PRODUCT_PHOTO_DISK_STAGING_ENABLED` is not `true`);
   - W10 rollback deletion;
   - Instagram prepare-image;
   - W6/W7/W8/W9 cleanup/promotion/deletion;
   - the unfenced W4 builder.

   None of them may be opened while any protected publication is unresolved.
5. Downgrade the code if required. Older code ignores the additive tables.
6. **Never drop or truncate** `photo_operations*`, `photo_w2_upload_intents`, `photo_publication_intents`, `photo_executor_exit_records` or `photo_publication_copies`, nor the private or staging directories. They are evidence.

**Command write-effect classification:**
| Command | Effect |
| --- | --- |
| `photos:release-preflight` | **Read-only.** Stats paths, reads migration and provenance files, hashes the launcher. Creates nothing |
| `photos:publication-intents` (default), `photos:operations-report` | **Read-only DB** |
| `photos:publication-intents -- --attest-exit …` | **Writes** one exit record |
| First fencing-ON W2/W4 request (readiness) | **Creates** missing roots (0700) |
| Service start (`ensureSchema`) | **Creates** missing tables and columns (additive) |
| `db:backup`, `photos:backup`, `db:restore-verify` | **Write** backup and verification artifacts |
| `npm run build:launcher -w apps/api` | **Writes** `apps/api/dist/bin/*` only |

## 4. Staging acceptance package (prepared, NOT executed)
No isolated F2 staging environment is verified to exist.

**Proposed disposable environment (owner review):**
- **Service:** one Render web service `noctella-f2-acceptance-api`. Native Node, Starter plan, one instance, the **composed candidate** commit, the §2 build command, and a 1 GB disk at `/var/data`.
- **Environment:**
  - `NODE_ENV=production`, `DATABASE_DRIVER=sqlite`, `DATABASE_URL=/var/data/noctella.sqlite`, `PRODUCT_PHOTO_DIR=/var/data/product-photos`;
  - `AI_INTAKE_PROVIDER` **unset or `mock`**: the local mock provider, no credentials;
  - `PHOTO_PREPARATION_CONFINEMENT=required`, `PHOTO_PREPARATION_LAUNCHER=<checkout>/apps/api/dist/bin/landlock-worker`;
  - `PRODUCT_PHOTO_DISK_STAGING_ENABLED=true`, `PHOTO_OWNERSHIP_FENCING_ENABLED=true`;
  - `ADMIN_APP_ORIGIN` set to the staging admin origin;
  - fresh secrets for staging only.
- **Isolation:** no production database, disk, backup bucket, marketplace, Instagram, Stripe or OpenAI credentials (unset). Only synthetic images.
- **Data:** a staging-only admin user (the existing admin seed procedure) and one category.
- **Cost basis:** one Starter instance plus 1 GB disk at Render's published prices. Verify before provisioning; nothing is provisioned by this package.
- **Teardown:** delete the service and its disk.

**Tooling** (`scripts/photo-staging-acceptance/`, self-tested in CI by `staging-driver.test.mjs`):
- `staging-driver.mjs` (operator machine). Uses the real routes:
  - `POST /api/auth/login`, which sets the `noctella_admin_session` cookie;
  - `POST /api/products/:id/photos`: multipart field `photo`, optional `altText`, header `Idempotency-Key` (16–128 chars `[A-Za-z0-9_-]`), permission `products.edit`, returns 201;
  - `POST /api/ai-product-intakes`, which takes body `{}`;
  - `POST /api/ai-product-intakes/:id/photos`, multipart field `photo`;
  - `POST /api/ai-product-intakes/:id/generate` (mock provider);
  - `PATCH /api/ai-product-intakes/:id/proposal/fields/title`, body `{decision:"accepted", expectedUpdatedAt}`;
  - `POST /api/ai-product-intakes/:id/stock-acceptance`, body `{categoryId, type:"unique_item", expectedProposalUpdatedAt}`, returns 201 with the product;
  - `POST /api/ai-product-intakes/:id/finalize-photos`, body `{}`. Returns 201 the first time and 200 when repeated.

  No `Origin` header is sent, which the admin CSRF guard accepts for non-browser clients. The driver refuses unless `F2_STAGING_CONFIRM_HOST` equals the API host.
- `park-at-intent.mjs` (staging service shell, from `apps/api`): **deterministic executor-loss setup.** It forks the existing `tests/fixtures/w2SigkillChild.ts`, which runs the real W2 owner against the service's own database and disk. It prints `PARKED` once the durable intent is authorized and before any canonical name exists.
  - It is not a runtime endpoint and not a production code path.
  - It refuses the production service ID, a missing `F2_STAGING_ACCEPTANCE=enabled`, and fencing OFF.
- `sample-cgroup.sh` (staging service shell, read-only): samples cgroup v2 `memory.current/peak/max/swap.max/events` of the container (API + confined preparers) and supplementary RSS.

**Steps:**
1. **Preflight (read-only):** `photos:release-preflight`. Expect `migrations.0040/41/43/44`, `launcher.provenance`, `flag.preparation-confinement` and `publication.exit-authentication` PASS. `storage.*` reports "will be created" before the first protected request; readiness creates the roots on first use.
2. **Missing confinement refusal:** set `PHOTO_PREPARATION_LAUNCHER=/nonexistent/landlock-worker` and redeploy. `driver w2` returns **503 `PHOTO_PUBLICATION_NOT_READY`**, and no file appears under `/var/data/product-photos`. Restore the variable and redeploy.
3. **W4 + product setup:** `driver w4 <categoryId> a.jpg b.jpg`. Expect `pass:true` (finalize 201 with 2 photos, repeat 200, no extra photos). The created product id is used below.
4. **W2 upload:** `driver w2 <productId> img.jpg`. Expect 201. `photos:operations-report` shows it committed, and `photos:publication-intents` shows nothing authorized.
5. **Idempotent replay** (not a lost acknowledgement): `driver w2-replay`. Same photo id.
6. **Lost acknowledgement after durable commit:** `driver w2-lost-ack <productId> img.jpg`. Expect `pass:true`:
   - the server answered 201;
   - the client never got it;
   - the retry with the same key returns the same id;
   - the photo count rose by exactly one and not again on retry.

   Server-side checks: `photos:operations-report` shows one committed operation for that key; product photos and promote outbox events each 1. The `/var/data/product-photos` file count rises by exactly 2 (main + thumb).
7. **Live-executor refusal and same-instance recovery:**
   - `park-at-intent.mjs <productId> small.jpg <adminUserId>` prints PARKED with `childPid` and the key.
   - `driver w2 <productId> small.jpg <key>` returns **409 `PHOTO_OPERATION_IN_PROGRESS`**.
   - `photos:publication-intents -- --attest-exit …` for that executor returns `refused: the executor process is alive`.
   - `kill -9 <childPid>`, then repeat the driver call. Expect 201: the API itself proves the death (same boot and PID namespace) and resumes at epoch 2 with no attestation.
8. **Cross-instance recovery:**
   - Run `park-at-intent.mjs` again (new key), then restart the service. The parked child dies with the old instance.
   - `driver w2 … <key>` returns 409; the report shows `resumable:false` with a `blockedReason`.
   - Attest with the exact `--operation/--epoch/--executor` and `--evidence "<Render restart event id and time>"`.
   - Retry. Expect 201 at epoch 2 with no duplicate photo or files.
9. **Resources in protected mode:** run `sample-cgroup.sh` during steps 3, 4, 6 and 7, with a fresh restart before each measured run, since `memory.peak` is a lifetime high-water mark.
   - The judgement uses the **existing accepted thresholds** in `scripts/photo-upload-linux/policy.mjs`: `memory.max` 512 MiB, no swap, `memory.peak` ≤ 384 MiB, and zero new `oom`/`oom_kill`/`max` events.
   - `/proc/meminfo` is not used, and RSS is supplementary.
   - **Limit:** the accepted fencing-ON resource workload is `combined-fencing-on` (3 trials × 8 operations, concurrency 3, 24 MP JPEG). It includes a W11 Instagram derivative, and the existing policy (`FENCING_ON_ACCEPTANCE.blocked`) marks it **BLOCKED until W11/0042 is approved**. The W2+W4 measurements here are a protected-mode **subset**: they cannot replace that acceptance, and are not fencing-OFF evidence.
10. **Disk:** after each step `du -s /var/data/.product-photo-publication` returns to ~0, since anchors are removed after commit. Free space stays above the policy's 256 MiB floor.
11. Teardown.

Local tests and CI are **not** staging acceptance. Nothing above has been executed.

## 5. Daily-use effects with fencing ON (NOT accepted by the owner)
| Function | Effect | Follow-up options (owner decision) |
| --- | --- | --- |
| Instagram prepare-image (live) | Refused (retryable `processing`); publishing needs a prepared asset | (a) adopt W11 under publication authority, which needs 0042 approval; (b) move Instagram derivatives to a separate non-canonical root and serve them separately |
| Canonical photo deletion (W8), AI-cleanup canonical deletion (W6) | Refused and dead-lettered; files accumulate on the 1 GB disk | (a) a deletion design under authority: delete only keys whose operation is committed and whose photo row is gone, inside the intent lock; (b) operator-reviewed periodic cleanup |
| ERP photo upload `POST /api/erp/products/:id/photos/upload` and the legacy upload route | Refused (503), because they use the W1 legacy writer | Route ERP uploads through the W2 owner (Idempotency-Key semantics needed) |
| Cross-instance executor loss (any restart/deploy during publication) | BLOCKED until operator attestation with evidence | (a) accept attestation; (b) a platform-provided instance-termination signal; (c) drain uploads before planned restarts |
| Deterministic restart acceptance | No fault hook in production code | A staging-only, env-gated delay hook (needs review because it ships in production code) |

None of these is marked complete; W11/0042 is not activated.

## 6. Copilot independent review brief (packaging boundary)
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
