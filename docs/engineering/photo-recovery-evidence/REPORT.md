# P2-2B3D3 (#396) recovery classification: evidence

Design: [`../P2-2B3D3_PHOTO_RECOVERY.md`](../P2-2B3D3_PHOTO_RECOVERY.md).

**Source base:** #408 head `a5b8236870507a0b60b262491d5d8256bcb1a19e`.

**Local environment:** Windows 11 / NTFS, Node v24.18.0, Sharp 0.34.5. PostgreSQL, Docker and Linux are unavailable locally.

Reproduce (from the repository root, after `npm ci && npm run build -w packages/shared`):
```bash
NOCTELLA_RECOVERY_EVIDENCE_DIR=out node --import tsx --test scripts/photo-recovery-reconciliation/recovery.test.cjs
# PostgreSQL parity: also set POSTGRES_TEST_DATABASE_URL to a disposable local database (as in CI)
```

## New suite: 19 tests, 10 passed, 0 failed, 9 skipped

The 9 skipped tests are all PostgreSQL cases (no local database); CI runs them. Every scenario asserts that recovery:
- left all artifact paths, inodes, sizes and SHA-256 hashes unchanged, as did any other action after the snapshot;
- left the `product_photos` and `outbox_events` row counts unchanged;
- reported `cleanup: BLOCKED_NOT_AUTHORIZED` and wrote a durable review record.

| Scenario (SQLite) | Classes observed (count) | Review |
| --- | --- | --- |
| Referenced canonical photo | REFERENCED 2, REFERENCED_VIA_CANONICAL_LINK 2, CURRENT_GENERATION_RETAINED 5 | no |
| Historical outbox-only reference (completed delete event) | REFERENCED 2 (source `outbox_events.product_photo.delete_requested.completed`), … | no |
| Lost COMMIT acknowledgement, row invisible | AMBIGUOUS_UNFENCED_ROOT 2; admission closed | **yes** |
| … same bytes after the committed row is visible | REFERENCED 2 | no |
| Stale generation, seals, ABA, unknown operation | UNREFERENCED_CANDIDATE 5 (g1 raw/work/input), SEALED_RECORD_RETAINED 2 (g1 seals), AMBIGUOUS_FUTURE_GENERATION 1 (g9 > 2), AMBIGUOUS_UNKNOWN_OPERATION 1 | **yes** |
| Zero-byte and partial | AMBIGUOUS_ZERO_BYTE 1 (canonical placeholder); stale-generation zero-byte encode = UNREFERENCED_CANDIDATE flagged "zero-byte partial output" | **yes** |
| DB unavailable or required table missing | AMBIGUOUS_DB_UNAVAILABLE 9 (all); admission closed | **yes** |
| Mixed-version legacy writer and deleter | AMBIGUOUS_UNFENCED_ROOT 2 (legacy upload, `.instagram-*.tmp`); `missingReferenced` 1 (thumbnail removed by a key-based deleter) | **yes** |
| Active writer during the snapshot | AMBIGUOUS_CHANGING 1 (late write to a stale generation between inventories); new owner's g2 files CURRENT/SEALED retained; two concurrent recoveries gave identical classes and separate records | **yes** |
| Retained accounting and disk budget | `DevelopmentPhotoDiskBudget.retainedBytes` identical before and after; candidate bytes reported, not freed; review → budget `closed` → `reserve()` throws `PHOTO_DISK_BUDGET_REVIEW_REQUIRED` | **yes** |
| SIGKILL inside the #406 marker section, then restart | OPERATION_MARKER_RETAINED (`locks/killed-op.lock`); marker still present afterwards | **yes** |

The full per-artifact reports (path, dev, ino, size, class, reasons) are in `local-windows/recovery-test-evidence.json`. The raw transcript is `local-windows/recovery-classification-output.txt`.

## Inherited suites and workspace checks (local, final source)

| Suite / check | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Storage capability (#406) | 48 | 25 | 0 | 23 (PostgreSQL / Windows symlink) |
| Operation fencing (#404) | 35 | 18 | 0 | 17 |
| Crash recovery (#398/#402) | 37 | 18 | 0 | 19 |
| Disk budget (#408) | 13 | 11 | 0 | 2 |
| Typecheck, all workspaces | PASS | | | |
| Lint, all workspaces | PASS | | | |

Not re-run locally:
- The API, Admin and Storefront vitest suites and the build. This change adds no imports into application code and only one unimported module. They run in CI.
- PostgreSQL acceptance. It runs in CI only.

Skips are not passes.

## Limitations

- PostgreSQL parity, Linux SIGKILL and ext4 behaviour of this suite have not been observed locally.
- The classifier relies on the #406 development authority (`probe_photo_*` tables). A production authority with the same guarantees does not exist.
- External references (published posts, marketplace listings, remote backup manifests) are not visible to the DB. Roots exposed to them are never candidates.
- About 7 disposable `noctella-photo-fence-*` directories from failed local harness runs during development were left in `os.tmpdir()`. They contain only synthetic data and were not deleted automatically.
