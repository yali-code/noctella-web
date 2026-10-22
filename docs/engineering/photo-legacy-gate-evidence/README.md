# P2-2B3D6 local evidence (Windows 11, Node v24.18.0)

Source: this branch's commit, based on #411 `8a03093`. The only application-source addition is the unimported development module `developmentLegacyWriterGate.ts`.

Reproduce:
```bash
NOCTELLA_LEGACY_GATE_EVIDENCE_DIR=out node --import tsx --test scripts/photo-legacy-gate/gate.test.cjs
# add POSTGRES_TEST_DATABASE_URL=<disposable local database> for the PostgreSQL parity case (as in CI)
```

| Suite / check | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| `photo-legacy-gate/gate.test.cjs` (new) | 12 | 11 | 0 | 1 (PostgreSQL; CI only) |
| Writer census guard (gate registered as DEV) | 3 | 3 | 0 | 0 |
| Ownership contract (#411) | 16 | 9 | 0 | 7 |
| Storage capability (#406) | 48 | 25 | 0 | 23 |
| Operation fencing (#404) | 35 | 18 | 0 | 17 |
| Crash recovery (#398/#402) | 37 | 18 | 0 | 19 |
| Disk budget (#408) | 13 | 11 | 0 | 2 |
| Recovery classification (#409) | 19 | 10 | 0 | 9 |
| Typecheck, all workspaces | PASS | | | |
| Lint, all workspaces | PASS | | | |

**Ungated baseline.** The new suite reproduces, on synthetic disposable files, that the current ungated `ProductPhotoDeleteHandler`, `ProductPhotoCleanupTempHandler` and `deleteManagedFile` (AI cleanup) remove canonical bytes. This is an expected unsafe baseline result, kept as evidence. It is not an acceptance failure.

**Gated cases.** These record SHA-256, inode and size inventories before and after; every one shows unchanged bytes.

**Skipped tests** need PostgreSQL, Linux SIGKILL, ext4 or Windows symlink privilege. **Not run locally:** the API, Admin and Storefront vitest suites and the build. No imported application code changed, so CI runs them. Dependencies came through local `node_modules` junctions (identical lockfile; not committed).
