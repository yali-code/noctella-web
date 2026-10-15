# Final readiness local evidence (Windows 11, Node v24.18.0)

Branch `feat/photo-storage-final-readiness`, based on #412 `44e0df2`. Evidence collected on source `cc0172e`; the later docs-only commits do not change it.

| Suite / check | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| `photo-final-readiness/ai-finalize.test.cjs` (new) | 8 | 4 | 0 | 4 (PostgreSQL; CI only) |
| Legacy gate (#412) | 12 | 11 | 0 | 1 |
| Ownership contract (#411) | 16 | 9 | 0 | 7 |
| Storage capability (#406) | 48 | 25 | 0 | 23 |
| Operation fencing (#404) | 35 | 18 | 0 | 17 |
| Crash recovery (#398/#402) | 37 | 18 | 0 | 19 |
| Disk budget (#408) | 13 | 11 | 0 | 2 |
| Recovery classification (#409, extended) | 19 | 10 | 0 | 9 |
| Writer census guard | 3 | 3 | 0 | 0 |
| API vitest (full) | 6,140 | 6,106 | 0 | 34 (280 files: 276 passed, 4 skipped) |
| Typecheck, all workspaces | PASS | | | |
| Lint, all workspaces | PASS | | | |

**Skipped tests** need PostgreSQL, Linux SIGKILL, ext4 or Windows symlink privilege. They run in CI, which has not been observed for this branch.

**Not run locally**, because the disk had less than 400 MiB free:
- the build;
- the Admin and Storefront vitest suites.

No Admin or Storefront code changed.

**#390 memory acceptance** was not run: there is no Linux cgroup environment here. See the readiness document, §4.

`api-vitest-output.txt.gz` is the complete gzipped API transcript. Local paths are redacted throughout.
