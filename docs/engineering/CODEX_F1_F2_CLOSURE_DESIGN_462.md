# F1/F2 offline design and supporting-test closure (#462)

Reviewed runtime base: `60a45569e19bf11d7af67123509d04d8dea3684b`. Prior hostile evidence: PR #461 at `bc1c91c15ec27c7767441f75510fa88c9907c7e5`. No new worker conclusions were consulted. First-pass scope is frozen in `CODEX_F1_F2_SCOPE_FREEZE_462.md`.

**Disposition: test-only design verification, not production security closure.** Runtime F1/F2 remain HIGH/FAIL until separately authorized integration. F1's stronger malicious-ancestor model remains unsupported by portable Node APIs; F2's fail-closed availability tradeoff requires owner acceptance. Independent AI evidence is not independent human approval. Baseline remains **4/12**, remaining **8/12**.

## What changed

Only files under tests, a focused CI workflow and design documents are added. `apps/api/src` and existing acceptance gates are unchanged. No 0042 registration/application, migration execution, live W11 integration, feature activation, merge, deployment, customer access or other-worker branch edits. The custom `audit_publication_*` tables exist only in a temporary SQLite database / uniquely named disposable PostgreSQL schema; they are not a proposed implementation of migration 0042.

A sparse isolated worktree excludes historical ZIP evidence after a full checkout failed writing those archives. Local dependencies are read via junctions to the already installed PR #461 audit worktree; lockfile SHA256 matches exactly. CI installs fresh locked dependencies at its exact head.

## Source-linked closure matrix

| Invariant | Runtime evidence at reviewed base | Offline result / boundary |
| --- | --- | --- |
| Hash and inode refer to one file | [shared fileProof:105-110](https://github.com/yali-code/noctella-web/blob/60a45569e19bf11d7af67123509d04d8dea3684b/apps/api/src/services/photoOperationAuthority.ts#L105) still stats then separately streams a pathname; shared by live W2/W4 | Test-only descriptor proof uses no-follow where supported, bigint fstat identities, bounded exact bytes, pre/post metadata and named-path checks. PASS for tested swaps/mutations under the ACL model. Runtime unchanged: F1 HIGH/FAIL. |
| Root/ancestor containment | [inactive owner:110-115](https://github.com/yali-code/noctella-web/blob/60a45569e19bf11d7af67123509d04d8dea3684b/apps/api/src/services/w11FencedInstagramDerivativeOwner.ts#L110) recursively creates paths through existing ancestors | Rejects persistent symlink/junction roots/ancestors and observed swaps. Explicit LIMIT test shows swap-and-restore can evade snapshots if attacker controls ancestor rename. Unconditional hostile-ancestor containment: INSUFFICIENT / unsupported. |
| No A link after B generation claim | [owner:118-137](https://github.com/yali-code/noctella-web/blob/60a45569e19bf11d7af67123509d04d8dea3684b/apps/api/src/services/w11FencedInstagramDerivativeOwner.ts#L118) publishes before final CAS | Durable publication intent CAS denies resumed A before link if B already claimed. Once A has intent, B cannot reclaim even after expiry or entry connection closure. PASS for tested custom protocol; runtime F2 HIGH/FAIL. |
| Connection loss cannot silently revoke filesystem authority | An ordinary DB row lock is ephemeral | REPRO test closes actual lock-holding connection, lets B claim, then lets A link. This rejects lock-only design. Corrected prototype closes entry connection deliberately before filesystem work and relies on committed non-expiring intent. |
| Canonical provenance/recovery | [owner:128-137](https://github.com/yali-code/noctella-web/blob/60a45569e19bf11d7af67123509d04d8dea3684b/apps/api/src/services/w11FencedInstagramDerivativeOwner.ts#L128) accepts equal bytes on EEXIST | Prototype requires canonical hash/bytes/dev/ino to match the exact intent's retained seal, refuses foreign equal-byte inode, resumes only the same intent after interruption. Does not alter F3/F5 worker scope or production schema. |
| Crash/power-loss durability | No W11 fsync ordering at owner:115-138 | Transaction rollback/connection-close and hook interruptions tested. DB commit persistence assumptions explicit. Host/power-loss, filesystem fsync ordering, backup restore and hard process death remain INSUFFICIENT EVIDENCE / F5 scope. |
| W11 startup refusal / 0042 inactivity | [mediaPreparation:130](https://github.com/yali-code/noctella-web/blob/60a45569e19bf11d7af67123509d04d8dea3684b/apps/api/src/integrations/instagram/mediaPreparation.ts#L130) | Preserved, no source import of test helpers, CI checks unchanged src/no registered 0042. Actual mixed fenced 24MP remains BLOCKED. |

## F1 trust and ACL model

1. A deployment provisioner supplies a stable absolute trust-anchor directory. Its own parents, mount, ownership and ACLs are trusted and independently verified. The helper checks the anchor and every descendant directory used; it does not attempt to traverse inaccessible parents above the anchor. Lexical escape, absolute paths, traversal components and alternate stream/drive-colon syntax are refused.
2. Untrusted HTTP callers have no rename, symlink/junction creation, mount replacement or direct write authority in the anchor/ancestors/private files. A malicious same-UID process, administrator, direct SQL writer, rogue publisher or compromised kernel is outside this prototype model. Separate service identities/root ownership or a privileged publication broker are needed if those actors are in scope. 0700/0600 alone do not isolate processes sharing one UID.
3. POSIX: O_NOFOLLOW protects the final component; it does NOT protect ancestors. Ancestor lstat/realpath and identity snapshots detect observed changes, not transient changes between snapshots. Linux LIMIT test actually moves a directory outside the anchor, temporarily substitutes a symlink, restores it after reading, and shows the snapshots can miss that interval. Do not remove this evidence or claim unconditional containment.
4. Windows: O_NOFOLLOW may be unavailable. lstat/realpath checks plus bigint descriptor identity are used; requested mode is not Windows ACL evidence. Junction rejection is exercised locally. An open handle prevented a directory-rename injection on Windows, so that attack test and the POSIX final-symlink/LIMIT tests run on Linux instead of treating OS denial as proof of the helper's post-checks.
5. Descriptor proof uses one opened file for pre/post fstat and hashing, checks exact bytes read, bigint dev/ino and size/mtimeNs/ctimeNs, and caps reading before excess allocation. These checks detect the tested mutation schedules, not malicious same-length write-and-restore under arbitrarily coarse metadata precision. Approved ACLs/immutability are still required.
6. The returned proof is evidence at read time, not a filesystem publication capability. Node's path-based link can race a later ancestor/source change. The trusted mutation model must cover the entire proof-to-link interval; otherwise use platform-specific descriptor-relative traversal/linking or a broker. Production provisioning evidence and such native APIs are not implemented here.

## F2 durable authority protocol

The original generation/lease checks protect DB commit, not canonical mutation. A separate pre-link check has a race. Holding a transaction across link also fails if a DB connection/lock disappears while the worker continues. Both rejected alternatives have explicit REPRO tests.

The safe prototype uses these states: `sealed -> publishing -> committed`. A `publishing` state is a **committed, non-expiring publication intent**, bound to operation identity, generation, owner, nonce and immutable seal. Lease expiry governs entering this state, not revoking it. This is a semantic/schema change requiring review, not a reinterpretation silently applied to W11.

1. Before authority acquisition, create an exclusive generation-private file under the provisioned roots. Seal immutable content hash/bytes/dev/ino and retain its private name and nonce history. No canonical file yet.
2. Transaction T1: acquire PostgreSQL FOR UPDATE / SQLite BEGIN IMMEDIATE on the operation guard. After lock acquisition, CAS sealed -> publishing using generation/owner/nonce/state and **fresh database time**. Insert the immutable intent alongside its sealed generation atomically. Commit T1. If CAS fails, never reach link.
3. If T1's acknowledgement is lost, do not guess authority from an in-memory flag; query the authoritative primary for the exact persisted intent and seal. If DB is unavailable or evidence mismatches, do no new filesystem work. The laboratory recovery re-enters T1 and checks the exact intent. No stale replica is allowed.
4. Every claimant/reclaimer must refuse `publishing`, regardless of lease. There is no automatic timeout, deletion, superseding generation or forced reclaim of that state. This rule survives normal connection closure because authority is persisted, not held only by a connection lock. A committed generation is also never reclaimed.
5. Close T1's connection before link (the tests enforce this structure). Verify the retained seal via descriptor proof, link only that authorized inode without replacement, then verify canonical proof against the same intent. EEXIST is accepted only for that exact seal inode/hash/bytes; equal-content foreign inode means review and no overwrite/delete.
6. T2: CAS publishing -> committed with the same generation/owner/nonce/intent. Do not reapply the old lease-expiry rule: the non-expiring intent already pinned authority. Allow idempotent same-intent completion. On a lost T2 acknowledgement, a retry validates committed evidence and returns without a link syscall.
7. Crash before T1 commit: no intent/no canonical action. Crash after T1 but before link: retain publishing and resume the same intent only. Crash after link but before T2: retain canonical/private evidence; resume same intent, verify inode, finish T2. Do not issue B a new generation. A wrong owner/nonce cannot resume. Inconclusive recovery stays blocked for operator review.
8. To revoke a stuck publication intent, an operator must first establish that every possible old publisher is stopped/fenced from canonical storage, reconcile DB/seals/files, and authorize a separate recovery procedure. A DB row edit or TTL alone cannot provide that proof. This prototype intentionally provides no revocation/purge command.

The fixture contains one operation per isolated DB/schema and therefore no cross-operation input. Production must bind intents/seals to operation ID, content key, source fingerprint, recipe and generation with immutable FK/unique constraints and durable history. The custom fixture is not a multi-operation schema proof. Schema registration, state CHECK changes and live claimant changes are blocked actions.

### Failure and availability tradeoffs

A permanently interrupted intent can stop one derivative indefinitely; this is deliberate fail-closed behavior. Canonical-root access must be restricted to protocol-following workers, with old binaries drained before integration. Direct rogue writes, an unfenced old binary, administrative DB mutations, split-brain primaries, or restoring DB/files while old workers survive invalidate the assumptions. The SQLite prototype uses dedicated file-backed connections and explicit BEGIN IMMEDIATE across awaited work; do not put an async callback in the existing synchronous Drizzle transaction helper. T1/T2 are short; no rendering occurs in them.

File/directory fsync ordering is still required before acknowledged production commit. The audit prototype verifies database logic and connection/interruption recovery; it does not certify host power-loss, network partition, disk durability or F5 closure. Retained private seals/intents must enter backup/restore and retention decisions. No automatic cleanup is proposed.

## Minimal reviewable integration proposal (not applied)

See `F1_F2_INTEGRATION_462.patch.proposal`. It expresses the smallest required call-site/protocol shape, not a compiled or approved activation patch. The executable design reference remains test-only. Required prerequisites are provisioned rooted access, immutable per-generation seal/intent storage, the non-reclaimable publishing state, all claimant updates, SQLite adapter design, retry classification, storage durability and owner acceptance. The existing proposal-only 0042 cannot support this protocol unchanged.

Do not import test code into src, remove the mediaPreparation refusal, register 0042, apply DDL, or toggle a feature as part of this PR. A separately authorized candidate and independent human review remain necessary.

## Verification and interpretation

Commands:

```sh
npm exec -w apps/api -- vitest run tests/f1f2PublicationClosure462.test.ts tests/instagramMediaPreparation.test.ts tests/photoOwnershipDriverRouting.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc -p apps/api/tests/support/tsconfig.audit462.json --noEmit
npm run typecheck -w apps/api
node --test scripts/photo-upload-linux/fencing-blocked.test.mjs scripts/photo-upload-linux/fencing-on-gates.test.mjs
```

Set AUDIT462_REQUIRE_POSTGRES=1 with an explicitly disposable POSTGRES_TEST_DATABASE_URL to require PostgreSQL; CI provisions PostgreSQL 16 and records each backend case. No repository migration function is invoked. REPRO means unsafe alternative demonstrated, PASS means the stated prototype invariant passed, LIMIT means an explicit stronger-model counterexample passed, skips mean not executed. Initial failures included inaccessible above-anchor Windows paths, a Windows open-handle rename denial, bigint-to-number inode rounding in a test, and inherited test-harness ES2022 typing; these were diagnosed without relaxing production fences. The fixture now preserves bigint identity and the test config targets Node-supported ES2022.

Local Windows: three suites 65 passed / 16 explicit skips (PostgreSQL, guard and three POSIX-only cases). API typecheck, separate test-helper typecheck and seven blocked-policy checks are reported with final exact-head CI in Issue #462. CI verifies production source and schema registration unchanged and uploads SHA/verbose logs. No baseline CI is substituted for the new head.

## Owner decisions and NOCTELLA LOOP

- Accept/reject the limited trusted-ancestor/ACL model or require native rooted operations/broker. Provide deployment ACL/mount evidence; AI tests cannot self-certify it.
- Accept/reject durable non-expiring publication intent and potentially indefinite derivative outage. Specify separately reviewed same-intent recovery and hard fencing before any revocation.
- Authorize separate schema/protocol integration only after independent human review, immutable seal/intent design, F3/F5 coordination, durability and migration planning. No such authorization is granted by this report.

OBSERVE exact base and prior red evidence; ACT only offline helpers/design; VERIFY hostile tests on real disposable backends; COMMIT only exclusive branch; CONTINUE through human review/scoped integration, keeping runtime blocked. **4/12 remains unchanged.**
