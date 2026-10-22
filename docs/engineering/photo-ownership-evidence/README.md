# P2-2B3D5 local evidence (Windows 11, Node v24.18.0)

Source: this branch's commit, based on #410 `6c4c2b8`. No application source changes.

Reproduce:
```bash
NOCTELLA_OWNERSHIP_EVIDENCE_DIR=out node --import tsx --test scripts/photo-ownership-schema/ownership.test.cjs
# add POSTGRES_TEST_DATABASE_URL=<disposable local database> for the PostgreSQL cases (as in CI)
```

| Suite / check | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| `photo-ownership-schema/ownership.test.cjs` (new) | 16 | 9 | 0 | 7 (PostgreSQL; CI only) |
| Writer census guard (#410) | 3 | 3 | 0 | 0 |
| Storage capability (#406) | 48 | 25 | 0 | 23 |
| Operation fencing (#404) | 35 | 18 | 0 | 17 |
| Crash recovery (#398/#402) | 37 | 18 | 0 | 19 |
| Disk budget (#408) | 13 | 11 | 0 | 2 |
| Recovery classification (#409) | 19 | 10 | 0 | 9 |
| Typecheck, all workspaces | PASS | | | |
| Lint, all workspaces | PASS | | | |

The first local run of the new suite had 4 harness failures, kept in this README rather than as separate files:
- three were `assert.rejects` given a synchronously throwing SQLite call, which needs an `async` wrapper;
- one test closed a stale database handle after a reopen, which caused EPERM on cleanup.

All four were fixed in the test harness only; the contract was unchanged.

**Skipped tests** need PostgreSQL, Linux SIGKILL, ext4 or Windows symlink privilege. **Not run locally:** the API, Admin and Storefront vitest suites and the build, because application source is unchanged; CI runs them. Dependencies came through local `node_modules` junctions (identical lockfile; not committed).

## CI fix (PR #411, run 38614710139)

The PostgreSQL case `lease-gated reclaim … (ABA)` failed with `''2'' !== 2`. node-postgres returns `BIGINT` (int8) as a string, and the adapter's `read()` returned raw rows. Fencing was not affected: it already compared through numeric casts, so a stale token was still rejected.

The fix is at the adapter boundary:
- `read()`, `token()` and the fence and seal checks now use a strict decoder (`int`). It accepts an exact safe integer as a number, a string or a bigint, and otherwise throws `PHOTO_BIGINT_OUT_OF_RANGE`. It never rounds.
- A driver-independent decoder test was added.
- The SIGKILL test now asserts `generation === 1` without a cast.

No assertion was weakened.
