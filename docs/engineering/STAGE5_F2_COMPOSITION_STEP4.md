# Stage 5 F2 — Step 4/5 W2/W4 publication and recovery composition — #472

Base: `cd57f489e533427fe015fb609dc310793a6f8503` (PR #484 merged into #471's branch). Branch: `test/stage5-f2-composition-step4`. Test-only composition module, two fixtures, one suite, required CI wiring and this document. No `apps/api/src`, migration, Render, flag, secret or provider change. Steps 1–3, Contract 1, the 470 LIMIT test, both original F2 reproductions and the existing W4 acceptance suite are unchanged and run in the same required job. The deferred step-0 lab is untouched. No AGENTS.md or LOOP.md exists in this baseline.

**Step 4 is not accepted until exact-head required Linux CI and independent review pass.** Runtime Photo F2: HIGH/FAIL. Production availability: NOT ACCEPTED. Official progress: 4/12.

## What is composed, and what is NOT
**Real runtime functions reused (unchanged):** `createOperation`, `claimExistingOperation`, `findOperationBySubject`, `createGenerationDirectory`, `sealPreparedArtifacts`, `reviewSteps`, `nowMs` (photo-operation authority); W2 `stagedProductPhotoStorage.prepareFencedProductPhoto`; W4 `prepareDeterministicProductPhotoFiles`; T2 building blocks `lockProductRowInTransaction`, `createProductPhotoWithPromotionOutboxInTransaction`, `finalizeIntakeWithExpectedStateInTransaction`; the Step 2 launcher (confinement, supervisor, reaper).

**Test-only components:** Contract 1 protocol (`tests/f2c1`: intent DDL, guarded W2 claim, T1, transfer, receipts, intent-authorized fence, composed W2 T2); Step 3 copy-owned publisher (`tests/f2s3`); Step 4 `tests/f2s4/composition.ts` (guarded W4 claim mirroring the real W4 claim, `publishAuthorized`, composed W4 T2 mirroring the real W4 use case row values and order: intake lock, product lock, per entry photo + outbox + fence, intake finalization).

**BLOCKED runtime seam (exact):** `uploadFencedProductPhoto` (`w2FencedProductPhotoOwner.ts`) and `buildFencedAiIntakePhotoFinalizationManifest` (`w4FencedFinalizationOwner.ts:95`) call `publishSealedArtifacts`, which links the worker-owned private inode, and both commit through the lease-fenced `commitDrizzlePhotoOperationFenced`. Neither accepts an injected publisher, intent or fence, and their claim steps do not consult a publication intent. Production integration therefore requires a reviewed runtime change (publisher seam, intent persistence, intent-authorized commit, guarded reclaim in both owners) and a schema change for the intent. This suite does not prove that integration.

## Topology (per case, real processes)
`test parent → reaper → supervisor → executor` (executor CONFINED; allowlist: canonical root, publisher staging root, operation-private root, database directory, own tmp) holds Contract 1 authority. `test parent → launcher → preparer` (CONFINED; allowlist: the generation directory and own tmp) runs the real W2/W4 preparation and then keeps a retained read/write descriptor and a hardlink alias. One IPC command = one protocol step; the reply is sent only after that step's transaction committed. Crashes are the executor SIGKILLing itself at an exact Step 3 phase (deterministic), or killing its supervisor.

## Ordering and authority invariants (asserted)
1. **No canonical name before T1.** Canonical names are absent after T1 and before publication; without held authority the executor refuses to publish or commit.
2. **Publication = publisher-owned verified copy.** Each canonical name is exactly the manifest-recorded inode (≠ the worker's sealed inode), holds the sealed bytes, and has `nlink == 1`; staging keeps only `manifest.json`.
3. **Physical publication precedes DB visibility; T2 is the only visibility point.** W2: one operation, main + thumb. W4: all staged photos in ONE finalization transaction; any collision/review makes the whole transaction fail (intent-authorized fence), leaving the intake `applied` and zero photos while successfully published names physically exist (W4 contract).
4. **Reclaim before intent** produces a new generation; the stale owner's T1 is rejected and it never creates a canonical name or commits.
5. **Active intent blocks reclaim**; transfer without an authenticated exit receipt returns `no-receipt` (BLOCKED).
6. **Authority transfer requires Step 2 authenticated completion**: exactly one supervisor `COMPLETE` record on its private channel, bound to the reaper-observed `INNER_EXIT code=0` of that supervisor, plus (PostgreSQL) no backend left for the executor's `application_name`; only then are Contract 1 receipts written. Supervisor loss yields no completion → no receipt → no transfer → reclaim refused.
7. **Recovery adopts only operation-authorized verified artifacts**: after a crash past the canonical link, the new executor's Step 3 publish reports `ADOPTED` with the identical inode; fresh links report `PUBLISHED` (never reused silently). Foreign files are `COLLISION` → review, untouched.
8. **Retained worker authority cannot alter published bytes**: the confined preparer's retained-fd and alias writes succeed against its source only; its attempt to open the canonical file for writing is denied; mutation after the seal makes publication `SNAPSHOT_MISMATCH` → review before any canonical name.
9. **Lost acknowledgement after T2** returns the durable committed result; no duplicate rows, outbox events or files.

## Acceptance matrix (`apps/api/tests/publicationCompositionStep4.test.ts`; each × SQLite and disposable PostgreSQL)
| Case | Items |
| --- | --- |
| W2-1/8 success + retained authority | 1, 8 |
| W2-2 reclaim before intent | 2 |
| W2-3/10 intent active, uncertain authority | 3, 10 |
| W2-5 lost T2 ack | 5 |
| W2 SIGKILL before intent / after intent / main verified / main linked / after commit | 4, 6, 9 |
| W2-7 foreign collision | 7 |
| W2-8 source mutation after seal | 8 |
| W2-10 supervisor loss | 10 |
| W4-1/8/9 two photos, single finalization, visibility | 1, 8, 9 |
| W4-2/3 reclaim before intent + intent active | 2, 3 |
| W4-5 lost finalization ack | 5 |
| W4-4/6/9 SIGKILL during photo 2 after its main link; adopt/publish; finalization; unrelated file untouched | 4, 6, 9 |
| W4-7 collision on photo 2 → whole finalization fails | 7, 9 |
| W4-10 supervisor loss | 10 |

## Review notes
- **Step 3 ENOENT robustness note**: `publish()` checks `existsSync(canonical)` then `lstat` in `resolveExisting`. A vanishing canonical name in between needs a concurrent remover; in this composition workers cannot remove canonical names (Landlock), executors never unlink them, Step 3 cleanup touches only its own staging data, and Contract 1 + Step 2 allow one live executor per operation. No deterministic case reaches it, so Step 3 is unchanged.
- **Staging ownership**: namespace `<staging>/<operationId>-<artifact>/<generation>/`, written only by the authorized executor; cleanup removes only its own `data-*` names.
- **Same filesystem**: staging, operation-private and canonical roots must share one filesystem (`link()` would fail with `EXDEV` otherwise); the suite places them under one root.

## Trust assumptions and gaps
The publication executor is trusted code whose authority is fenced by Contract 1 and Step 2 (it can write the canonical root while it holds authority); preparation workers are untrusted and confined. Step 2 A1–A5 apply (no reachable spawn service, ptrace scoping, IPC never spawns, supervisor survives or BLOCKED, single host). Metadata is not protected (Landlock ABI 3). Not covered: production owner integration (seam above), the intent schema migration, cross-host writers, concurrent publishers outside Contract 1, power-loss durability, Render topology (Landlock ABI/enforcement unknown; observed UID/GID 1000, `/var/data` `root:render` 2775 only).

## Evidence status
Local host: Windows 11, no Linux — **no native case executed locally** (38 skipped). A scratch, uncommitted in-process Windows logic smoke (no confinement, no processes; directory fsync shimmed) reproduced W2 success, W4 single-transaction success and W4 collision rollback; it is not evidence. Native evidence requires the required `w2-live-adoption-gate` job (`F2_CAPABILITY_REQUIRE_LINUX=1`, `F2C1_REQUIRE_POSTGRES=1`, zero skips).
