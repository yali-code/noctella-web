# Independent W11 security and adversarial evidence (#455 / #457)

Reviewed implementation SHA: `60a45569e19bf11d7af67123509d04d8dea3684b`.
Branch: `audit/faz-a-codex-w11-security-457`; target: `fix/photo-ownership-driver-routing-458`.

Verdict: **FAIL for W11 activation; current inactive fences PASS; actual fencing-ON mixed acceptance BLOCKED.** This is independent AI technical evidence, not independent human approval. Source-first findings were frozen in `CODEX_W11_FIRST_PASS_457.md` before consulting new agent reports; no new Claude/Copilot report was consulted. Earlier context of this reviewer's own #455 report cannot be erased.

## Changes and boundaries

Added a disposable adversarial evidence suite and focused Linux/PostgreSQL CI. Production source, migration registration, live W11 wiring, flags and existing acceptance assertions are unchanged. A REPRO test passes only when the vulnerable behavior is observed; it is not a security PASS. There are no expected-failure assertions or weakened security gates. Tests may write/delete only their generated temporary files and disposable database schemas, never customer data.

The new workflow checks out the exact PR head, requires disposable PostgreSQL (`W2_LIVE_REQUIRE_POSTGRES=1`), runs unchanged W11/schema/media/C1/W3 regressions and the blocked-fencing tests, typechecks, and runs the existing real ext4 disk-budget/ENOSPC suite. It retains logs as an artifact. It does not alter the Photo Master workflow or its acceptance policy. Its green status means evidence collection succeeded, not activation is secure.

## F1-F5 matrix (line numbers refer to reviewed implementation SHA)

| Finding | Severity / disposition | Mechanism and executable evidence | Minimal correction / missing evidence |
| --- | --- | --- | --- |
| F1: file identity and containment | HIGH / FAIL, reproduced | `photoOperationAuthority.ts:105-110` stats one pathname resolution and streams another. The test renames the actual file after lstat, creates B, and proves B's SHA paired with A's inode and size. `w11FencedInstagramDerivativeOwner.ts:110-115` follows an existing private-root directory symlink/junction; the test proves a generation directory is created in an outside synthetic directory. | Descriptor-bound no-follow open/stat/read/post-stat with change rejection; root/ancestor containment and filesystem access model. wx/0600 do not prevent ancestor traversal. Remote exploitability/deployment ACLs are unverified. |
| F2: stale canonical publication | HIGH / FAIL, reproduced | Owner `:118-137`: generation A seals, expires; B claims/seals generation 2 and pauses; A publishes its inode and loses only at commit CAS. Test proves canonical inode belongs to A while DB is sealed generation 2, then B adopts equal bytes. | Specify an atomic publication authorization protocol or explicitly review/accept weaker content-based semantics. A separate pre-link ownership check alone leaves a race. Current DB CAS works; filesystem fencing does not enforce the stronger invariant. |
| F3: foreign same-byte inode | MEDIUM / FAIL against documented provenance invariant, reproduced | Owner `:128-137` skips inode/dev comparison when link returns EEXIST; `:96-103` committed retry checks only hash. Test pre-creates an equal-content foreign inode and proves committed state with canonical inode different from sealed inode. | Authenticate previous-generation provenance separately from a foreign equal-content file; preserve crash-recovery behavior. Byte equality reduces content risk but does not establish ownership. |
| F4: retry classification / proposed wiring | MEDIUM / FAIL, EIO reproduced in current live fencing-OFF path | Media `:153-170` catches injected write EIO as `invalid_media`, retryable=false. The proposed call inside the same try (`W11_FENCED_WIRING_DESIGN.md:38-59`) inherits this unless catch logic changes; the sketch also omits `canonicalRoot: root`. Current fencing-ON refusal at media `:130` remains processing/retryable=true. | Human-reviewed complete integration patch with consistent root and explicit infrastructure/refusal error mapping. Do not implement prohibited live integration. Proposed DB/schema-error and custom-root mapping remain static assessment because activation is absent. |
| F5: crash durability | MEDIUM / INSUFFICIENT EVIDENCE | Owner `:115-138` has no file or directory fsync ordering before DB commit/private unlink. Hook exceptions and lost-return fault injection demonstrate retry behavior, not power-loss persistence. Original staging writer `aiIntakePhotoStorage.ts:180-202` explicitly syncs file/directory; this is a useful existing protocol, not proof for W11. | Define crash/storage model; file and directory persistence before acknowledged DB commit; validate real crash ordering on supported storage. Host/power-loss experiments were not executed. |

All source paths above are under `apps/api/src/services/`, except media at `apps/api/src/integrations/instagram/mediaPreparation.ts` and design at `docs/engineering/W11_FENCED_WIRING_DESIGN.md`.

## Verified invariants and limits

- Current live W11 fencing ON refuses before source I/O; owner remains an inactive prototype with no production import. Proposed 0042 remains only `docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal`.
- DB time (`photoOperationAuthority.ts:41`), immediate SQLite transactions / async PostgreSQL transactions (`:46-69`), row lock and generation/expiry reclaim (`owner:31-52`), seal/commit CAS (`:55-68`) and unique history nonce (`proposal:30-39`) protect DB ownership. Tests cover active duplicate claims, conflicts, changed source bytes, ABA nonce rejection and lost-return recovery.
- File publication remains link-only and no-overwrite; only the private filename is unlinked. Permissions are requested as wx/0600 and exclusive generation directories (`owner:110-138`); hardlinks do not make an inode immutable to a writer holding permissions.
- Source reading (`media:50-72`) binds its buffered read to an opened descriptor, verifies inode/root and checks timestamps/size after reading. Existing media tests inject source/destination swaps and symlinks; arbitrary ancestor mutation is not exhaustively proven.
- Committed missing/tampered files are refused and flagged (`owner:96-103`), diagnostics list review/expired/flagged operations (`:143-148`), rollback predicate blocks unfinished/review/flagged state (`:152`). A query is advisory, not an enforced DROP restriction; quiescence and retained ownership evidence remain prerequisites.
- W3 original staging remains default-OFF and test/development-only (`aiIntakeOriginalSourceStaging.ts:14-22`). It is not enabled by this work.
- Real SQLite/PostgreSQL tests exercise the inactive owner, never production integration. Lost transaction response is injected after the real transaction has committed, not a dropped network packet. EIO/ENOSPC in the new owner suite are injected; existing ext4 tests are actual bounded-disk tests, not W11 durability proof.

## Reproduction commands

From the repository root:

```sh
npm ci --no-audit --no-fund
npm exec -w apps/api -- vitest run tests/w11IndependentAdversarialEvidence.test.ts --reporter=verbose
npm exec -w apps/api -- vitest run tests/w11FencedInstagramDerivativeProposal.test.ts tests/w11Derivative0042SchemaReview.test.ts tests/instagramMediaPreparation.test.ts tests/photoOwnershipDriverRouting.test.ts tests/aiIntakeOriginalSourceStaging.test.ts
node --test scripts/photo-upload-linux/fencing-blocked.test.mjs scripts/photo-upload-linux/fencing-on-gates.test.mjs
npm run typecheck -w apps/api
```

Set `POSTGRES_TEST_DATABASE_URL` to an explicitly disposable database and `W2_LIVE_REQUIRE_POSTGRES=1` to require PostgreSQL; the existing harness rejects non-disposable database names and creates random schemas. Never point tests at staging or production. Linux CI provisions PostgreSQL 16 itself. The workflow contains the exact disposable ext4 command; no privileged disk operation was performed locally.

## Evidence status at commit preparation

Local Windows / Node 24: six focused suites passed (83 passed, 28 explicitly skipped for absent PostgreSQL/config guards); blocked-policy tests 7/7. Final targeted rerun and typecheck results are recorded in the delivery issue comment. Earlier runs had a dependency-not-yet-installed failure and a test-fixture DDL API error (`all` on CREATE); these were not security findings. DDL fixture was corrected to SQLite exec / PostgreSQL execute. No acceptance assertion was relaxed.

The exact-head Draft PR CI, backend parity, artifact, and final counts will be linked in Issue #455 and cross-referenced in #457 after execution. Do not infer PostgreSQL execution from a local skipped suite or reuse baseline CI as evidence for the new tests.

## Remaining decisions and NOCTELLA LOOP

No vulnerability correction was applied to production/shared runtime code in this evidence PR. F1 needs a separately validated shared-helper/containment change; F2/F3 need a reviewed ownership/provenance protocol; F4's actual integration is expressly prohibited; F5 needs a supported storage/crash contract. The minimal corrections above are proposals, not authorization to apply denied edits. The recorded three classifier denials remain respected; no denied integration edit, alternate activation switch or classifier override was attempted.

OBSERVE: exact base and source-first findings frozen. ACT: independent disposable tests and CI. VERIFY: targeted local evidence and exact-head CI. COMMIT: only owned audit branch. CONTINUE: human review and scoped corrections; keep W11 inactive, 0042 unregistered and authentic fencing-ON 24MP BLOCKED.

FAZ A progress: baseline **4/12**, remaining **8/12**; no increment without authoritative stage mapping. Current blocker: F1-F4 security failures, F5 durability evidence, independent human review and separate owner authorization. Next authorized action: review this evidence and plan isolated corrections within explicit permissions. No merge/deployment/migration/production activation is implied.
