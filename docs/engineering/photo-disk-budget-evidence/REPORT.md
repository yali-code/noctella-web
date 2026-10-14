# P2-2B3D2 (#407) disk budget: measured evidence

Design and conclusions: [`../P2-2B3D2_PHOTO_DISK_BUDGET.md`](../P2-2B3D2_PHOTO_DISK_BUDGET.md).

**Source base:** #406 head `ac4a4ff2059f5bc58ab37f391a72ca6c40d2ca83`.

**Delivery commit:** see the Draft PR; this report lives in that commit.

## Environment (local)

| Item | Value |
| --- | --- |
| OS / filesystem | Windows 11 Home 10.0.26200, NTFS, 4,096-B clusters (`statfs.bsize`). `st_blocks` is not exposed, so allocation is cluster-rounded |
| CPU / RAM | Intel i5-3210M, 4 logical CPUs, 7.9 GiB |
| Node / Sharp / libvips | v24.18.0 / 0.34.5 / 8.17.3 |
| Unavailable locally | PostgreSQL, Docker (Docker Desktop failed to start: no WSL distribution), Linux, elevation (no VHD or small-volume mount) |

## Files

| File | Content |
| --- | --- |
| `measure-windows-full-run1.json` | Full run 1: 5 seeded fixtures × 5 paths, all checkpoints |
| `measure-windows-full-run2.json` | Full run 2 with per-file `ino` / `nlink` / bytes / SHA-256 listings. Identical fixture hashes; 0 peak differences against run 1 across 25 path runs |
| `measure-windows-quick.json` | Tiny-fixture run with listings (the profile the CI loop filesystem uses) |
| `local-windows/*-output.txt` | Raw `node --test` transcripts for the inherited suites and this suite; typecheck and lint transcripts |
| `local-windows/budget-test-evidence.json` | Records from the budget tests: profiles, inventory, cross-process race outcomes, SIGKILL exits |

Reproduce from the repository root:
```bash
npm ci && npm run build -w packages/shared
node --import tsx scripts/photo-disk-budget/measure.cjs --out full.json          # ~6 min locally
node --import tsx scripts/photo-disk-budget/measure.cjs --quick --out quick.json
node --import tsx --test scripts/photo-disk-budget/budget.test.cjs
```

## Fixtures (seeded, synthetic, reproducible)

| Fixture | Pixels | Input bytes | Quality | SHA-256 (prefix) |
| --- | --- | --- | --- | --- |
| jpeg-24mp-near-limit | 6000×4000 | 10,185,754 | 72 | `639d53135de96193…` |
| webp-24mp-near-limit | 6000×4000 | 10,255,554 | 82 | `cae8827fb12da0f9…` |
| png-near-limit | 2600×1394 | 10,254,433 | – | `a698be8ac9c3a2c4…` |
| jpeg-2000px-max-entropy | 2000×2000 | 9,536,144 | 98 | `cedeb8090b7f5b45…` |
| png-rgba-max-entropy | 1700×1700 | 10,201,697 | – | `f93ca553b93286aa…` |

The exact byte counts and hashes are the `fixture` objects in both full-run JSON files. Values in this table are copied from run 2.

## Measured peaks

All values are MiB, deduplicated per inode and cluster-rounded. B1 is the existing staged HTTP storage; D1 is the #406 capability.

| Fixture | B1 peak | B1 after | D1 product (peak = after) | D1 + HTTP ingress | D1 deterministic | D1 2nd generation adds | Largest main / thumbnail output (B) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jpeg-24mp | 10.191 | 0.477 | 10.668 | 20.383 | 0.953 | +10.668 | 493,398 / 1,592 |
| webp-24mp | 10.371 | 0.590 | 10.961 | 20.742 | 1.180 | +10.961 | 613,758 / 1,610 |
| png-near-limit | 10.516 | 0.734 | 11.250 | 21.031 | 1.469 | +11.250 | 762,346 / 2,226 |
| jpeg-2000 max-entropy | 11.898 | 2.801 | 14.699 | 23.797 | 5.602 | +14.699 | 2,893,534 / 39,118 |
| png-rgba max-entropy | 13.465 | 3.734 | 17.199 | 26.930 | 7.469 | +17.199 | 3,760,546 / 151,514 |

Inode proof (from the run-2 listings, D1 product):
- canonical `op.webp` and `sealed/main.webp` share one inode (nlink 2);
- `raw/<key>.webp` and `work/main.webp` share another (nlink 2);
- `work/input` is alone (nlink 1).

That gives 5 payload inodes. Per-path counting would over-report: for the RGBA case it gives 20.92 MiB against 17.20 MiB per inode.

## Ledger tests (local Windows): 12 tests, 10 passed, 0 failed, 2 skipped

| Test | Result |
| --- | --- |
| Profiles: 42-MiB and 74-MiB constants under-count (B1 44,052,480 B; D1 77,631,488 B; D1 via HTTP 88,129,536 B; deterministic 67,145,728 B) | PASS |
| 42-versus-74: a budget of exactly one B1 reservation rejects D1 whole with no record written; 128 MiB admits only one D1-via-HTTP attempt | PASS |
| Hardlink counted once; zero-byte placeholder counts an inode; retained bytes shrink admission | PASS |
| Free-space and inode floors, outstanding reservations subtracted from free space, statfs failure → `PHOTO_DISK_ACCOUNTING_UNAVAILABLE` | PASS |
| Malformed or tampered records retained and fail closed | PASS |
| `close()` persists across instances; no reopen | PASS |
| Constructor refuses non-development environments and non-disposable roots | PASS |
| Cross-process race: 6 processes contend for a 3-reservation budget; exactly 3 admitted, 3 `PHOTO_DISK_BUDGET_EXHAUSTED` | PASS |
| SIGKILL while holding a reservation: record retained and still counted | PASS |
| SIGKILL inside the ledger lock: lock retained; later callers get `PHOTO_DISK_BUDGET_BUSY` | PASS |
| Symlink in accounted root → `PHOTO_DISK_INVENTORY_UNSAFE` | SKIPPED (Windows symlink privilege); runs in CI |
| Real ENOSPC on a 64-MiB ext4 loop mount | SKIPPED locally (needs Linux); runs in CI |

## Inherited suites (local Windows, unchanged code)

| Suite | Tests | Passed | Failed | Skipped | Skip reason |
| --- | --- | --- | --- | --- | --- |
| `photo-storage-capability/storage.test.cjs` | 48 | 25 | 0 | 23 | PostgreSQL unavailable, Windows symlink privilege; same counts as #406's local run |
| `photo-operation-fencing/fencing.test.cjs` | 35 | 18 | 0 | 17 | PostgreSQL unavailable / Linux-only |
| `photo-crash-recovery/recovery.test.cjs` | 37 | 18 | 0 | 19 | PostgreSQL unavailable / Linux SIGKILL cases |

Skips are not passes. The PostgreSQL, Linux SIGKILL and real-ENOSPC acceptance depends on CI, which has not run for this branch (see the PR).

## Not measured

- Linux `st_blocks`, ext4 directory blocks, journal effects and real ENOSPC. The CI step `Disposable photo disk budget (ext4 loop ENOSPC and allocation evidence)` produces these as artifact `photo-disk-budget-<run_id>`.
- SQLite WAL growth per upload. It is below the resolution of this probe; the disposable DB stayed at 5,737,952 B.
- A 2000×2000 RGBA max-entropy output. Such an input cannot be encoded under 10 MiB in the accepted formats.
- Production disk, concurrency or traffic. No production data or roots were used.

## Workspace validation (local Windows, final source)

| Check | Result | Notes |
| --- | --- | --- |
| Typecheck (all workspaces) | PASS | `typecheck-output.txt` |
| Lint (all workspaces) | PASS | `lint-output.txt` |
| Build (all workspaces) | PASS | `build-output.txt`, with non-production example origins |
| API vitest | **6,105 passed, 1 failed, 34 skipped** (280 files) | The failure is `stripeCheckoutSprint127` "response-loss replay", a 5-s timeout. API source is identical to #406 apart from the new unimported module |
| Stripe file alone | 21 passed, 2 timed out at 5 s; **23/23 PASS with `--testTimeout=30000`** | Timing on this machine (worker-spawning tests), not a logic failure. `stripe-isolated*.txt` |
| Admin vitest | PASS, 925/925 (130 files) | |
| Storefront vitest | PASS, 376/376 (36 files) | |
| `test:postgres` (51) | 17 passed, 34 skipped | No PostgreSQL locally. **Real PostgreSQL acceptance is NOT RUN** |
| CI (Linux, PostgreSQL, ext4 ENOSPC, SIGKILL) | **NOT RUN** | Runs only when a PR targets `feat/photo-storage-capabilities-p2-2b3d1` |

An earlier full API run hung with no progress for 15 minutes: 4.7 s of CPU and no workers. It was stopped and re-run; `api-test-output.txt.gz` is the complete transcript of the re-run. The first lines of that transcript are the stopped run's exit message, which was written to the same file.

## Conclusion

| Item | Verdict |
| --- | --- |
| 42-versus-74 discrepancy | **PASS.** Resolved with measured inode sets; both constants under-count |
| Conservative accounting and fail-closed admission primitive | **PASS** locally. Linux ext4 and ENOSPC evidence pending CI |
| Writer integration | **BLOCKED**: retain-only growth, 14 unprotected writers, owner budget decision, no CI evidence yet |
| Production readiness or all-writer protection | **Not claimed**; #396 OPEN, #390 BLOCKED |
