# FAZ A consolidated acceptance report (#424, comment 6220301971)

Branch `feat/faz-a-consolidated-424`, based on Draft PR #451 (`c5d081c`). Nothing here is merged, deployed or activated.
Status values: PASS (verified with the evidence named), BLOCKED (needs a separately confirmed owner decision),
NOT RUN.

## Gates

| Package | Gate | Status | Evidence |
| --- | --- | --- | --- |
| A | Baseline: main `7df99ba` ends at migration 0038; stack #446 → #447 → #448 → #450 → #451 is Draft and unmerged | PASS | GitHub API state; Photo Master CI 11/11 on #451 (run 38932096206) |
| A | #449 duplicate reconciliation | PASS | #449 is superseded; its Docker-free regression was ported into #450 |
| A | Migration numbering: 0039 = Etsy (unmerged, products columns only), 0040/0041 = photo, 0042 = proposal only; no ledger | PASS (WARN: the 0039 gap remains on this candidate) | `photos:release-preflight` checks `migrations.*` |
| A | W1–W14 inventory | PASS | `scripts/photo-writer-adoption/fencing-disposition.test.cjs` |
| B | 0042 approval-ready inactive candidate | PASS (inactive) / BLOCKED (activation) | See "0042 activation candidate" below |
| C | W11 real writer adoption (live route) | BLOCKED | The live W11 writer still refuses under fencing ON (`mediaPreparation.ts`). The safety classifier denied removing that refusal ([Security Weaken]), and it also requires owner approval of 0042. Not retried. |
| D | Genuine fencing-ON 24 MP acceptance | BLOCKED | `FENCING_ON_ACCEPTANCE.blocked=true`; `run-host` exits 3 with zero cases (#451 gates) |
| E | Writer/deleter audit (W1, W5–W10, W12–W14) | PASS | `fencing-disposition.test.cjs`: every census file has a disposition with a source proof; there is no unfenced canonical writer |
| F | Read-only operator report | PASS | `photos:operations-report` and `apps/api/tests/photoOperationRecoveryReport.test.ts` (SQLite + PostgreSQL) |
| G | Release/rollback preflight | PASS (local) | `photos:release-preflight` and `apps/api/tests/photoReleasePreflight.test.ts` |
| H | Integrated acceptance | See the PR CI run | Photo Master CI on this branch |

## Writer dispositions (package E)

| Disposition | Writers |
| --- | --- |
| ADOPTED (fenced) | W2 product upload, W4 AI finalization |
| REFUSED (under fencing ON) | W1, W6, W7, W8, W9, W11 (live) |
| PRIVATE (outside the canonical root) | W3/AI-intake staging, W5 |
| INACTIVE PROPOSAL | `w11FencedInstagramDerivativeOwner.ts` |
| SEPARATE ROOT (`MEDIA_ASSET_DIR` or private temporary directories) | W12 reel renderer, W13/W14 backups |

## 0042 activation candidate (package B evidence, throwaway worktree, never pushed)

I registered the proposal DDL in a throwaway worktree:
- appended to `apps/api/src/db/schema.sql`;
- added as `postgres-migrations/0042_photo_derivative_operations.sql`, a verbatim copy of `0042_photo_derivative_operations.sql.proposal`.

Results of the schema and photo suites against that candidate:
- 111 passed and 3 failed. The 3 failures are the intentional "0042 is inactive" assertions, which an approved activation PR must update:
  - `w11Derivative0042SchemaReview` "is not registered";
  - `photoOperationRecoveryReport` "W11 is absent";
  - `photoReleasePreflight` "unregistered 0042" (expected to become WARN "requires recorded owner approval").
- `scripts/photo-ownership-schema/ownership.test.cjs` passed 10/10, run the CI way (`node --import tsx --test`).

No production startup or migration path was changed on this branch.

## Owner decisions required

1. Approve W11 migration 0042 (`W11_0042_OWNER_DECISION_RECORD.md`). This unblocks B activation and then C.
2. After 1: approve connecting the live W11 route to the fenced owner. This removes the fencing-ON refusal, which only an owner-approved change may do.
3. After 1 and 2: approve the fencing-ON 24 MP acceptance run (D).
4. The order of the 0039 Etsy migration relative to 0040/0041 on main.
5. W3 original-source retention (its flag cannot be activated outside test/development).

## Operator steps before any release (MANUAL, never automated here)

- `npm run photos:release-preflight -w apps/api`: needs no FAIL. Every WARN must be read.
- `db:backup`, `photos:backup`, `db:restore-verify`: record the hashes.
- Render: confirm the old instance has stopped before the new one starts, and that no worker or cron can reach `PRODUCT_PHOTO_DIR`.
- After deploying: `npm run photos:operations-report -w apps/api`. Exit 2 means attention is needed. Follow `PHOTO_OPERATION_FENCING_RUNBOOK.md` and never delete files or edit rows from the report.
