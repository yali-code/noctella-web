# W11 security review packet and FAZ A owner decision table (#424)

Audience: the repository owner and an independent security reviewer.

Status:
- Production W11 still refuses with `PHOTO_OWNERSHIP_FENCING_ENABLED=true`.
- 0042 is still unregistered, as `docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal`.
- Nothing in this packet has been applied.

## 1. The three recorded safety denials (closure mission, comment 6224053880)

| # | Attempted change | Classifier reason | What it would have done | Disposition |
| --- | --- | --- | --- | --- |
| 1 | Remove `if (photoOwnershipFencingEnabled()) throw new InstagramClientError("processing", true);` in `apps/api/src/integrations/instagram/mediaPreparation.ts` (throwaway candidate) | Security Weaken | Ends the fail-closed W11 refusal under fencing ON | Reverted, never retried |
| 2 | Replace that refusal with `if (fenced && !w11FencedDerivativeConfig().enabled) throw …`, adding a default-OFF, test/development-only `W11_FENCED_DERIVATIVE_ENABLED` | Auto-Mode Bypass | A new switch that lets the fenced owner publish into the canonical root under fencing | Reverted (also the unused config) |
| 3 | Add three offline tests to `w11FencedInstagramDerivativeProposal.test.ts`: crash before seal, live lease, sticky review | Security Weaken | Tests only; they tamper with private generation files in a disposable directory | Not applied; the one partial import line was reverted |

Reading of the denials:
- Any change that lets a W11 writer mutate the canonical photo root while fencing is ON is treated as relaxing a safety control, even behind a new default-OFF switch.
- That requires a human authorization decision. An agent cannot self-approve it, and must not route around it by renaming the switch, moving the check or splitting the diff.

Denial 3 concerned tests only. It is recorded as-is, and the owner or reviewer may add those tests themselves.

## 2. Exact authorization requirement

W11 live wiring needs both of the following, recorded by the owner on #424 (or in the decision record), before any agent edits `mediaPreparation.ts`:

1. **Owner approval of the 0042 schema for a Draft candidate.**
   - The DDL is moved into `apps/api/src/db/schema.sql` and `postgres-migrations/0042_photo_derivative_operations.sql`.
   - This is separate from approving it as a live migration (decision table, row a).
2. **An independent security review of the wiring diff below.**
   - Done by a human reviewer, not the authoring agent.
   - Recorded on the PR, with the reviewer confirming each invariant in §4.

The owner can then:
- apply the diff themselves; or
- explicitly grant the agent permission for that single file edit in the Claude Code permission settings.

Without one of these, the change stays BLOCKED.

## 3. Minimal proposed W11 + 0042 diff (NOT APPLIED)

The wiring diff is unchanged from `W11_FENCED_WIRING_DESIGN.md` §B, which is the one already reviewed in #448 and #450.
- **Schema:** append the proposal DDL verbatim to `schema.sql` and register `0042_photo_derivative_operations.sql`.
- **Writer, `mediaPreparation.ts`:** with fencing ON, call `prepareFencedInstagramDerivative`.
  - Use a dynamic import to avoid the import cycle with the owner module.
  - Pass `dbRuntime.db`, `sourceKey: filename`, the validated `source` and `recipeId`.
  - Require the returned key to equal the expected `derivative`.
- **Error mapping:**
  - `W11_OPERATION_IN_PROGRESS` and `W11_OPERATION_FENCE_LOST` map to `processing` (retryable).
  - `W11_OPERATION_REVIEW`, `W11_OPERATION_CONFLICT` and database/schema errors map to `processing` (retryable). A missing 0042 table therefore fails closed.
- **Unchanged:** the fencing-OFF path is byte-identical, and the legacy temp-in-canonical-root writer stays unreachable under fencing.
- **Optional:** a production gate such as denial 2's opt-in, if the owner wants staging-only activation. This needs explicit owner wording because the classifier treats it as a bypass.

Tests the activating PR must flip or add:
- **Flip:**
  - `w11Derivative0042SchemaReview` "is not registered" becomes a registered check;
  - `photoOperationRecoveryReport` "W11 is absent" becomes a W11-present check;
  - the `photoReleasePreflight` real-inventory check becomes WARN;
  - the wiring gate `w11LiveStillRefusesUnderFencing` becomes a positive check;
  - `fencing-disposition.test.cjs` changes W11 to ADOPTED;
  - the census entry for the owner becomes ADOPTED.
- **Add:**
  - live W11 under fencing ON, on SQLite and PostgreSQL;
  - denial 3's three tests;
  - the existing 29 W11 tests unchanged with fencing OFF.
- **Harness:** `FENCING_ON_ACCEPTANCE.blocked=false`, and `validateFencingOnEvidence` expects 1 committed `instagram_derivative`.

## 4. Invariants the reviewer must confirm

- **Database time, CAS and history:**
  - leases use database time only;
  - reclaim happens only after expiry with the expected generation;
  - seal and commit are CAS on (generation, owner, nonce, state, lease [, seal hash]);
  - generation history is preserved with UNIQUE (operation, nonce).
- **Private writes:** an exclusive generation-private directory under `<parent>/.product-photo-operations/derivatives/<id>/<gen>`, written with `wx` and mode 0600; generation directories are never reused.
- **Publication:** `link()` only, never rename or overwrite; post-link hash and inode equal the seal; a foreign or changed file means review and is never replaced.
- **No deletion:** canonical bytes are never deleted; a committed derivative with changed or missing bytes is flagged, not rewritten.
- **Contract and rollback:**
  - the fencing-OFF behavior and the caller contract (`processing` / `invalid_media`) are unchanged;
  - `DERIVATIVE_ROLLBACK_BLOCKERS_SQL` blocks dropping the tables while unfinished, review or flagged rows exist.

## 5. Owner decision table

Each row is a separate decision. The defaults recommended here are technical and are NOT applied.

| Decision | Choices | Recommended technical default | Blocks |
| --- | --- | --- | --- |
| (a) Schema 0042 | (1) approve for the Draft candidate only; (2) approve as a live migration; (3) amend; (4) reject (W11 stays refused under fencing) | (1) now; (2) only after a staging run with 0042 | Gate 1 registration, then (b) |
| (b) W11 live wiring | (1) authorize after an independent security review of §3/§4, applied by the owner or with an explicit single-edit permission; (2) defer: fencing ON means no Instagram image preparation | (1), reviewed by someone other than the authoring agent | Gates 2 and 3 |
| (c) Migration sequencing | 0039 Etsy (products columns, unmerged), 0040 ownership, 0041 W2 intents, 0042 W11. They are independent (no cross-references; idempotent `IF NOT EXISTS`; no ledger). Choose either Etsy first or photo first | Merge in numeric order 0039 → 0040 → 0041 → (0042). Never renumber an applied migration | release |
| (d) Retention and backups | raw W3 originals: keep / time-box / off; private generation directories (W2/W4/W11): keep for audit / time-boxed purge with review; backups: include or exclude `.product-photo-operations` | W3 originals OFF in production (as today); keep private generation files until a reviewed purge tool exists; include them in backups | gate 5 sign-off |
| (e) Outage accepted with fencing ON | W1 legacy upload 503; W6 cleanup refused (files retained); W7 distinct-root promotion refused; W8/W9 deletes dead-lettered (files retained until review); W11 Instagram preparation refused until (b) | Keep fencing OFF in production until (b) is done; or accept the W11 outage explicitly with a dated note | fencing activation |
| (f) Staging, Render drain, release | separate authorizations for: staging deploy; the Render single-instance drain check; production deploy; fencing flag ON | Each authorized separately: preflight with no FAIL, backups plus restore-verify, drain confirmed, then deploy; flags OFF on first deploy | gates 6 and 7, release |

The admin `Idempotency-Key` gap is fixed in code (Draft PR from `fix/admin-photo-upload-idempotency-424`) and needs only normal review, not an owner policy decision.
