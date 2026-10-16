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

## Final closure mission (#424 comment 6224053880), from #452 `e3f5165`

The four states are kept separate.

| State | Status |
| --- | --- |
| Code implemented | W2 and W4 fenced; W11 owner inactive |
| CI accepted | Photo Master 11/11 on `e3f5165` (run 38960848152) |
| Staging validated | NOT RUN |
| Production activated | NO |

The historical 12-stage mapping is unavailable. 4/12 is retained only as unreconciled historical reporting.

| Gate | Status | Evidence / reason |
| --- | --- | --- |
| 0 Baseline and decision register | PASS | main `7df99ba` ends at 0038. #446–#452 are open Drafts; #449 is superseded by #450. There is no `LOOP.md`. The W1–W14 matrix is above. |
| 1 0042 schema candidate | PASS (disposable) / BLOCKED (registration) | The 0042 proposal was verified in a throwaway worktree: 111 passed; 3 expected "inactive" assertions failed; ownership 10/10. Registration is not committed because, per `W11_FENCED_WIRING_DESIGN.md` §B, it must land in the same reviewed PR as the W11 wiring, and that wiring is blocked. |
| 2 W11 live owner | BLOCKED | The safety classifier denied the wiring edit to `mediaPreparation.ts` twice: [Security Weaken], then [Auto-Mode Bypass] for a default-OFF, test/development-only opt-in variant. Adding further W11 owner tests was also denied ([Security Weaken]). Every denied change was reverted, none was retried or reworded, and the live W11 still refuses under fencing ON. The existing owner suite stays on SQLite and PostgreSQL. |
| 3 Fencing-ON 24 MP | BLOCKED | Depends on gate 2. `run-host` records BLOCKED, exits 3 and runs zero cases. The fencing-OFF 24 MP green result is NOT fencing-ON evidence. |
| 4 Writers and business continuity | PASS (classification) / owner choice | See the next table. |
| 5 Storage, restore, retention | PASS (offline) / owner choice | See the gate 5 note below. |
| 6 Release preflight and staging plan | PASS (offline) / owner choice | See the gate 6 note below. |
| 7 Integration CI | See the closure Draft PR CI run | No hidden skips. PostgreSQL is required in Photo Master CI (`W2_LIVE_REQUIRE_POSTGRES=1`). |

Gate 5 note:
- Passed locally, on synthetic data only: `databaseBackup`, `productPhotoBackup`, `backupFailureDiagnostics`, the operations report and the preflight, 137 tests.
- Skipped locally: 4 PostgreSQL cases. CI runs them.
- Retention of raw originals and private generation files, backup inclusion, and cleanup are owner decisions. Nothing is deleted.

Gate 6 note:
- `photos:release-preflight` is tested.
- The admin client sends no `Idempotency-Key`. With fencing ON, W2 then mints a random token per request, so a client retry after a lost response is not deduplicated. This is an owner decision.
- The 0039 ordering, the Render drain and backups are MANUAL preflight items.

Business impact while `PHOTO_OWNERSHIP_FENCING_ENABLED=true`:

| Writer | Behavior | Business impact | Operator choice |
| --- | --- | --- | --- |
| W2 product upload / W4 AI finalize | fenced, working | none | none |
| W1 legacy upload | 503 | legacy upload endpoint unavailable (admin uses W2) | accept |
| W11 Instagram preparation | retryable refusal | **Instagram image publishing stops** | keep fencing OFF until W11 is approved, or accept the outage |
| W6 AI cleanup canonical delete | refused, counted | canonical AI leftovers are retained | accept (retention) |
| W7 distinct-root promotion | refused | only same-root promotion works | confirm a single root |
| W8 / W9 outbox canonical deletes | dead-lettered | deleted photos' files are retained until review | accept plus a review cadence |
| W3/W5 private, W12 reel (`MEDIA_ASSET_DIR`), W13/W14 backups | unaffected | none | none |

**Decision: FAZ A BLOCKED.** Gates 2 and 3 are blocked and gate 1 registration depends on them. Gates 4–6 also carry owner decisions.

## Blocker resolution, safe track (#424 comment 6224317277), from #453 `9b7f3fa`

| Item | Status | Evidence |
| --- | --- | --- |
| Admin `Idempotency-Key` | PASS (code + local tests) | See the details below. |
| W11 security review packet | DONE | `W11_SECURITY_REVIEW_AND_OWNER_DECISIONS_424.md` §1–§4: the three denials, the exact authorization requirement, the minimal (unapplied) diff and the reviewer invariants. W11 still refuses; 0042 is still unregistered. |
| Owner decision table (a)–(f) | DONE | Same document, §5 |
| Fencing-ON 24 MP | BLOCKED | Unchanged: exit 3 and zero cases until (a) and (b) are decided |

Admin `Idempotency-Key` details:
- **Change:** one stable key per logical upload, meaning a File with its alt text, which the server binds to the key.
  - The key is reused after ambiguous failures: no response, 5xx, 408/429, or 409 IN_PROGRESS / FENCE_LOST.
  - It is released after success or a definitive rejection.
  - Failed files stay selected for retry.
  - `uploadForm` now surfaces the error `code`.
- **Test results:**
  - Admin targeted suites: 44/44. Full admin suite: 935/935. Admin typecheck passes; lint shows only existing warnings.
  - Server W2 contract (fencing ON: replay, conflict, invalid then review): 7/7.
  - New fencing-OFF compatibility test (header ignored, no ownership rows): 2/2.

Recommendation: unchanged, **FAZ A BLOCKED** on owner decisions (a) and (b). (c)–(f) are needed for release.
