# Issue #407 — P2-2B3D2: disk-budgeted photo storage writer integration

**Status: BLOCKED for writer integration. Design and measurements only, plus a development-only disk-budget primitive.**

- Stacked on Draft #406 (`feat/photo-storage-capabilities-p2-2b3d1`) at exactly `ac4a4ff2059f5bc58ab37f391a72ca6c40d2ca83`. Parents #404, #402 and #398 and every existing worktree are unchanged.
- No production writer, route, service default, scheduler or outbox handler uses the #406 capability or the new budget. `PRODUCT_PHOTO_DISK_STAGING_ENABLED` stays OFF by default.
- #396 stays OPEN. #390 stays BLOCKED.

This change delivers four things:
1. A measured resolution of the 42-MiB versus 74-MiB discrepancy.
2. An end-to-end disk-budget model.
3. An inventory of every media writer and deleter, with each one's protection status.
4. A development-only, fail-closed, cross-process reservation ledger (`apps/api/src/services/developmentPhotoDiskBudget.ts`) with tests and a CI step for Linux ext4 ENOSPC and `st_blocks` evidence.

A first-writer slice was **not** implemented. The gates it requires are not proven (see the [blockers](#blockers-why-no-writer-was-integrated)).

## 1. Resolving 42 MiB versus 74 MiB

The two numbers are policy caps for **different inode sets**. Neither has been measured as the footprint of the integration #407 asks for.

| Path | Distinct payload inodes held at peak | Policy cap per attempt | Released after success? |
| --- | --- | --- | --- |
| B1 staged HTTP (`productPhotoUpload.ts` + `LocalStagedProductPhotoStorage`) | request `input`, `main.webp`, `thumb.webp`. Canonical publication is a hardlink and adds no inode | `RESERVATION = 42 MiB` (10 + 16 + 16) | Yes. The request directory is removed; only the canonical inode pair remains |
| D1 capability, product (`prepareProduct` → `publish`) | capability `work/input`, `work/main`, `work/thumb` (the `raw/` names are hardlinks to these), `sealed/main`, `sealed/thumb`. The canonical names are hardlinks to the sealed copies | 74 MiB (10 + 2×16 + 2×16) | **No.** Everything stays in the private generation tree permanently: retain-only, no private GC |
| D1 capability fed by HTTP ingress | the above, plus the HTTP staging `input` (the capability re-writes its own copy from a Buffer) | **84 MiB** (2×10 + 4×16) | No (only the ingress copy is released) |
| D1 capability, deterministic | `raw/main`, `raw/thumb`, `sealed/main`, `sealed/thumb`. The AI source is retained where it already lives | 64 MiB | No |
| Every reclaimed generation (crash/ambiguity retry) | a complete second private tree | +74 MiB (product) | No. Retained until operator review |

The inode sets come from real per-file listings (`scripts/photo-disk-budget/measure.cjs`, the `files` arrays in the evidence). For example, on the D1 product path the canonical and sealed names share an inode (nlink 2), the raw and work names share an inode, and the input stands alone.

### Why both caps under-count

- **Multer sentinel.** Multer's limit is `max + 1`, so the HTTP `input` can reach 10 MiB + 1 byte on disk before rejection. With 4-KiB blocks that file allocates 10 MiB + 4 KiB.
- **Block rounding and metadata.** Each payload rounds up to whole blocks. Each private directory (1 for B1, 7 for D1 product) takes at least one block, and so does the operation marker.
- **Output caps are checked after the write.** The 16-MiB output limit applies after libvips has written the file, so a pathological output could exceed its reservation before rejection. On the synthetic corpus, the measured maximum is 3.59 MiB for main and 0.14 MiB for thumbnail (see below). The cap is therefore 4.5× above anything observed, but it is enforced only after the write.
- **Retention.** D1's retain-only policy means the per-attempt footprint never returns to zero. B1 leaves only the canonical pair.

The block-exact conservative reservations, computed by `attemptReservation` with 4-KiB blocks:

| Profile | Reservation | Versus its policy number |
| --- | --- | --- |
| `b1StagedHttp` | 42.012 MiB (44,052,480 B) | **exceeds the 42-MiB constant** |
| `d1CapabilityProduct` | 74.035 MiB | exceeds 74 MiB |
| `d1CapabilityProductViaHttp` | 84.047 MiB | not previously stated |
| `d1CapabilityDeterministic` | 64.035 MiB | not previously stated |

**Conclusion.**
- The 42-MiB reservation is not sufficient even for the existing B1 path. The shortfall is a few kilobytes of sentinel, rounding and directory overhead.
- 74 MiB is not the number for HTTP adoption: feeding HTTP ingress into the capability needs ≥ 84.05 MiB in flight, plus everything retained permanently.
- No quota was raised. The B1 route constants are unchanged; correcting the shipped B1 constant is a separate owner decision.

### Measured footprint (Windows 11 / NTFS / Node 24.18.0 / Sharp 0.34.5 / libvips 8.17.3, 4-KiB clusters)

Allocation here is size rounded up to the cluster, because NTFS exposes no `st_blocks`. Linux `st_blocks` evidence comes from the CI step (`measure-runner-full.json`, `measure-ext4-loop-quick.json`). Inputs are synthetic and seeded, generated as close as possible to the 10-MiB input limit.

All columns are in MiB:
- **Peak:** maximum deduplicated footprint during the attempt.
- **After:** footprint once the attempt has finished.
- **Gen-2 adds:** additional bytes retained by one reclaimed generation.

| Fixture (input) | B1 peak | B1 after | D1 product peak = after | D1 via HTTP | D1 deterministic | D1 gen-2 adds |
| --- | --- | --- | --- | --- | --- | --- |
| JPEG 6000×4000, 9.71 MiB | 10.19 | 0.48 | 10.67 | 20.38 | 0.95 | +10.67 |
| WebP 6000×4000, 9.78 MiB | 10.37 | 0.59 | 10.96 | 20.74 | 1.18 | +10.96 |
| PNG 2600×1394, 9.78 MiB | 10.52 | 0.73 | 11.25 | 21.03 | 1.47 | +11.25 |
| JPEG 2000×2000 max-entropy, 9.09 MiB | 11.90 | 2.80 | 14.70 | 23.80 | 5.60 | +14.70 |
| PNG RGBA 1700×1700 max-entropy, 9.73 MiB | 13.47 | 3.73 | 17.20 | 26.93 | 7.47 | +17.20 |

- **Per-path versus per-inode counts.** Counting per path double-counts hardlinks. The B1 Linux observer already noted this. For the RGBA case, per-path counting gives 20.92 MiB for D1 against 17.20 MiB per inode. Admission must count per inode.
- **Retained cost.** Under D1, a *successful* near-limit upload permanently consumes about 10.7–17.2 MiB of private disk, against 0.5–3.7 MiB under B1: 3–22× the canonical growth.
  - A 128-MiB private budget therefore admits roughly 7–11 successful D1 uploads in total before admission must close.
  - At the 84-MiB conservative in-flight reservation, it admits exactly one HTTP-fed attempt at a time.
- **Outputs stay far below the 16-MiB cap.**
  - Largest main output: 3,760,546 B (RGBA max-entropy; main ≤ 2000 px per edge).
  - Largest thumbnail: 151,514 B.
  - A 2000×2000 RGBA max-entropy input cannot be encoded under 10 MiB in these formats, so the extrapolated worst case (~5 MiB) is untested.
- **Disposable database.** The SQLite file stayed at 5,737,952 B in every run. A single upload's WAL growth is below this measurement's resolution; the probe does not force checkpoints. DB/WAL growth is covered by the free-space floor, not by the private budget.

## 2. End-to-end disk budget

Admission is all-or-nothing and conservative. An attempt is admitted only if all of the following hold:

```text
retained private inventory      (per-inode allocated bytes; st_blocks*512 on POSIX, cluster-rounded otherwise; directories ≥ 1 block)
+ Σ outstanding reservation records   (live and crash-retained alike)
+ this attempt's full reservation     (attemptReservation(profile, statfs.bsize))
≤ budgetBytes

statfs free bytes − Σ outstanding reservations − this reservation ≥ freeSpaceFloorBytes
statfs free inodes − Σ outstanding inodes − this attempt's inodes ≥ freeInodeFloor   (where the FS reports inodes; NTFS does not)
```

- **No partial acceptance.** A rejected attempt writes nothing, not even a record (tested).
- **Bytes counted twice on purpose.** While a reservation is live, its partially written files appear both in the inventory and in the reservation. Double counting only errs safe.
- **Zero-byte placeholders.** Files created with `wx` before encoding (B1 reserves output paths this way) are 0 bytes. The live reservation still counts their full cap, and after a crash the retained record keeps counting it.
- **Hardlinks.** The inventory deduplicates by `(dev, ino)`, so canonical and sealed links are counted once.
  - Canonical growth is **not** inside the private budget, because canonical media are durable product data.
  - Canonical growth, DB/WAL, backups (temporary trees in `os.tmpdir()` with the same mount risk), Instagram derivatives, reels and logs are protected by `freeSpaceFloorBytes` against the real `statfs` value.
- **Free-space races.** Other writers (SQLite WAL, backup downloads, unbudgeted legacy writers, other services on the same disk) can consume space between the check and the write. The floor reduces this risk; it cannot remove it. Every budgeted writer must therefore treat `ENOSPC`, or any unknown write outcome, as fail-closed:
  - retain the bytes;
  - `close()` the budget;
  - stop admission for **all** processes until operator review.

  There is no reopen API and no automatic reclaim.
- **Cross-process coordination.**
  - All cooperating processes share one ledger directory: an exclusive `wx` lock with a nonce, and per-reservation `wx` + `fsync` records.
  - A process releases only the record it created, after checking that record's inode and nonce.
  - A SIGKILLed holder's record is retained and keeps counting.
  - A SIGKILL inside the ledger section leaves the lock behind, so every process reports `PHOTO_DISK_BUDGET_BUSY` until review. There is no PID or age based stealing; this matches #406's marker policy and trades availability for safety.
- **Inode exhaustion.** On ext4, `statfs.ffree` is enforced. The CI loop filesystem is created with a fixed inode count.

## 3. Writer, deleter and reader inventory

| # | Surface | Mutation | Root | Budget / capability protection today |
| --- | --- | --- | --- | --- |
| 1 | Legacy product upload (flag OFF): `routes/products.ts` → `LocalPhotoStorage.saveProductPhoto` | `writeFile` main/thumb; compensation `rm` | canonical | **Unprotected** (no budget, no fencing) |
| 2 | Staged product upload (flag ON): `productPhotoUpload.ts` + `LocalStagedProductPhotoStorage` | staging `input`, `wx` placeholders, `toFile`, `link` publish, owned-canonical `rm` on failure, request-directory `rm` | staging sibling + canonical | **Partial:** in-process 42-MiB software reservation and 128-MiB aggregate (under-counts, see §1); no capability, no cross-process ledger |
| 3 | AI intake upload: `aiIntakePhotoStorage.saveIntakePhoto` (+ `.ai-intake-upload-ingress` when the flag is ON) | `wx` placeholder, `toFile`, own-partial `rm` | AI intake private root | **Unprotected** by any budget |
| 4 | AI deterministic finalization: `writeDeterministicProductPhoto` (default root) | idempotent `writeFile` main/thumb | canonical | **Unprotected** by default. The #406 private-root variant exists for development only |
| 5 | AI intake deletion: `deleteIntakePhoto` → `deleteManagedFile` | `unlink` | AI intake private root | **Unprotected**; outside retain-only |
| 6 | AI intake cleanup: `aiIntakeCleanup` → `deleteManagedFile(productPhotoStaticRoot, key)` | `unlink` of private **and canonical** files | AI intake private root + canonical | **Unprotected**; holds canonical deletion authority, which contradicts retain-only |
| 7 | Outbox `ProductPhotoPromotionHandler` | same root: existence checks; distinct roots: `copyFile` + `unlink` | canonical | **Unprotected**; production uses the same root (no copy) |
| 8 | Outbox `ProductPhotoDeleteHandler` (from `deleteProductPhoto`, products and ERP routes) | `unlink` of canonical keys from the event payload | canonical | **Unprotected**; key-based canonical deletion |
| 9 | Outbox `ProductPhotoCleanupTempHandler` | `unlink` temp-root keys (= canonical root in production) | canonical | **Unprotected** |
| 10 | `products.ts` upload compensation | `storage.deleteProductPhoto` (`rm`) on DB failure | canonical | **Unprotected** (B1 retains on ambiguity; legacy deletes) |
| 11 | Instagram preparation (`mediaPreparation.ts`) | `.instagram-*.tmp` `writeFile` (wx), `link`, `unlink` | **canonical product-photo root** | **Unprotected**; shares the canonical root |
| 12 | Reel renderer (FFmpeg) | `.partial.mp4`, `rename`, `rm` | `MEDIA_ASSET_DIR` | **Unprotected**; separate root, same disk on Render |
| 13 | Photo backup / recovery verification | `mkdtemp` + `writeFile` + `rm` in `os.tmpdir()`; `wx` downloads | tmp | **Unprotected**; temporary space not budgeted |
| 14 | DB backup / restore materialization | `mkdtemp`, `link` to destination, `rm` | tmp / DB directory | **Unprotected** (DB-owned) |
| 15 | #406 `DevelopmentPhotoStorageCapability` | private generation tree, sealed copies, canonical `link`, markers | disposable private + canonical | Protected; **development only**, no budget wired in |
| 16 | New `DevelopmentPhotoDiskBudget` | ledger lock/records/closed marker only; never media | disposable budget root | Development only; not wired |

Readers whose contracts must not change: static serving under `/images/product-photos`, publishing payloads (eBay, Etsy, Web, Instagram URLs), backup manifests, Admin content reads, and historical outbox payloads that carry `url`, `storageKey` and `thumbnailStorageKey`.

**Every surface except #15 and #16 bypasses the protected boundary.** All-writer adoption is therefore not claimed.

## 4. All-writer integration design (not implemented)

The order is mandatory. A later step must not be enabled while an earlier bypass can still run against the same roots.

1. **One shared physical namespace and ledger per persistent disk.**
   - The canonical root, capability private root and budget ledger live on the same filesystem (publication requires `link`, so `EXDEV` must fail closed).
   - One budget directory is shared by every process that can write media (API workers and any job runner).
2. **Every producer calls `reserve(profile)` before allocating anything:** before the DB lookup, multipart parse or directory creation, matching B1's current lease position.
   - It holds the reservation until its private bytes are durably accounted for (sealed and recorded) or the attempt fails closed.
   - Only then does it release, after the native work has settled; release never happens early on abort or timeout.
   - The 30-second multipart receive timeout and abort behaviour stay as in B1. Abort cancels queued and receiving work, but cannot shorten native encoding.
3. **HTTP product upload (writer 2)** feeds the capability **by path** from the staging input. This needs a new capability entry point that adopts the staged inode (`link` into the work directory) instead of re-writing a Buffer, which brings the profile from 84 down to 74 MiB.
   - The recipe, random canonical key spelling, URL shape, `sizeBytes = original size`, photo order, primary photo, alt text and the promotion outbox payload must stay byte-identical. The existing contract tests must pass unchanged.
4. **AI deterministic finalization (writer 4)** uses `prepareDeterministic` under the same token transaction that already creates the ProductPhoto row and its Promote outbox event.
   - Retries skip preparation when already finalized, as today.
   - The source is retained (#398 retain guard). A lost COMMIT acknowledgement retains the bytes and reports review-required.
5. **AI intake upload (writer 3)** and **Instagram (writer 11)** reserve under their own profiles; Instagram moves its temporary file out of the canonical root into a private sibling.
6. **Compensators and deleters (writers 5, 6, 8, 9, 10)** stop deleting canonical bytes by key.
   - Canonical deletion becomes a separate, reference-census-backed operator action (#396).
   - Historical outbox events that still carry delete or cleanup payloads are drained, or explicitly no-op'd, **before** capability writers are enabled. A mixed-version window in which old handlers delete canonical keys published through hardlinks must not exist.
7. **Private retention.** The capability currently keeps every input, raw and sealed inode forever (measured 10.7–17.2 MiB per successful near-limit upload). A proven, token-fenced, reference-aware private-GC protocol (#396) must exist before any production writer uses it; otherwise the budget closes admission after a few uploads.
8. **Mixed-version rollout:**
   - Stop and drain every old writer before enabling capability writers (Render stops the old instance before starting a new one when a disk is attached; this must be confirmed for the actual service).
   - Enable all writers together behind one restart-scoped flag. Turning the flag off does not delete anything.
9. **Engine-specific hazards:**
   - Stale SQLite async continuations stay forbidden through `guardSqliteCallback` and the lifetime revocation added in #406.
   - A lost PostgreSQL connection keeps the filesystem marker until settlement. This is tested in #406's Linux CI, not locally.

## Blockers (why no writer was integrated)

| Gate | Status |
| --- | --- |
| Conservative per-attempt accounting | Done for all four profiles; B1's 42-MiB constant shown to under-count |
| Real ENOSPC on a real filesystem | Implemented as a CI step (64-MiB ext4 loop mount). **Not run:** the stacked PR was not opened from this machine, so no CI run exists. Local Windows cannot mount a small filesystem without elevation, and Docker/WSL are unavailable |
| Linux `st_blocks` allocation | Same CI step. **Not run** |
| Cross-process ledger, SIGKILL in record and lock | Passed locally on Windows (6 processes contending, 3 admitted; retained records and locks) |
| PostgreSQL parity | The ledger is filesystem-only, so engine-independent. Integration-level parity (token transaction + reservation) was **not implemented or tested**. No PostgreSQL is available locally |
| Private retention / GC under budget | **BLOCKER.** Retain-only capability plus a finite budget means permanent admission exhaustion. GC needs #396's reference census |
| Unprotected writers 1–14 | **BLOCKER.** Includes canonical-deleting outbox handlers and AI cleanup, plus Instagram temporary files in the canonical root |
| Budget sizing | **Owner decision.** No silent quota increase. B1's constant needs correcting; the capability profile needs ≥ 74.04 MiB (path-fed) or ≥ 84.05 MiB (Buffer-fed) per in-flight attempt, plus retained inventory |
| #390 memory gate (24 MP / 512 MiB) | Remains FAILED/BLOCKED (see P2-2B2) |

## Validation

Local Windows results:

| Check | Result |
| --- | --- |
| New ledger tests | 10 passed, 2 skipped (Windows symlink privilege; Linux-only real ENOSPC) |
| Inherited storage, fencing and crash suites | 25/23, 18/17, 18/19 (passed/skipped); 0 failed |
| PostgreSQL harness | 17 passed, 34 skipped (no PostgreSQL) |
| Typecheck, lint, build | PASS |
| API | 6,105 passed, 1 timing failure (Stripe, 23/23 with a 30-s timeout), 34 skipped |
| Admin / Storefront | 925/925, 376/376 |
| CI | NOT RUN |

The exact counts and transcripts are in `photo-disk-budget-evidence/REPORT.md`.

## Rollback

- Remove `developmentPhotoDiskBudget.ts`, `scripts/photo-disk-budget/`, the CI step and its artifact upload, and this document with its evidence.
- No route, default, schema, migration, flag or production configuration was added, so there is nothing else to undo.
- Parents #406, #404, #402 and #398 are untouched.
- Disposable ledgers live only under `os.tmpdir()/noctella-photo-fence-*`. Leftover locks or records from killed test processes are test artifacts and are not production state.
