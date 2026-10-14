# P2-2B3D4 local validation transcripts (Windows 11, Node v24.18.0)

Source: this branch's commit, based on #409 `b61f7e8`. No application source is changed.

| Suite / check | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| `photo-writer-adoption/census.test.cjs` (new) | 3 | 3 | 0 | 0 |
| Storage capability (#406) | 48 | 25 | 0 | 23 |
| Operation fencing (#404) | 35 | 18 | 0 | 17 |
| Crash recovery (#398/#402) | 37 | 18 | 0 | 19 |
| Disk budget (#408) | 13 | 11 | 0 | 2 |
| Recovery classification (#409) | 19 | 10 | 0 | 9 |
| Typecheck, all workspaces | PASS | | | |
| Lint, all workspaces | PASS | | | |

**Skipped tests:** they need PostgreSQL, Linux SIGKILL, ext4 or Windows symlink privilege. They run in CI, which has not been observed for this branch. Skips are not passes.

**Negative check:** a temporary unlisted `writeFile` in `apps/api/src/services` made the census fail as intended. The probe file was removed and is not committed.

**Not run locally:**
- API, Admin and Storefront vitest suites, and the build. Application source is unchanged from #409, so these are left to CI.
- Dependencies came through local `node_modules` junctions to the P2-2B3D3 worktree, because the lockfile is identical and disk space was low. The junctions are not committed.
