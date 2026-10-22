# Stage 5 candidate: W2/W4 descriptor verification correction

Base: PR #464 `782942a1f12686b665dd15e6f275c4bab0ac182c` (verified Photo Master 39019112431, 11/11). Exclusive branch: `fix/faz-a-stage5-w2-w4-descriptor-proof`. This implements one runtime invariant; it does not claim overall F1/F2 or official Stage 5 acceptance.

## Applied correction

The old shared proof stats a pathname, then streams a separately opened pathname. Rename/replacement can pair B's bytes with A's inode/size. Live W2/W4 call it when sealing, before canonical link and after link.

`ownedPhotoArtifactProof.ts` now proves those W2/W4 artifacts through one descriptor: final-component POSIX no-follow, nonblocking open against FIFO substitution, bigint descriptor identity, pre/post size/mtime/ctime, exact bytes read, named-path revalidation, bounded 64-KiB memory, validated-size-plus-sentinel growth refusal, and guaranteed close. OS I/O failures propagate as their original errors. Successful return shape stays sha256/bytes/dev/ino.

Only `sealPreparedArtifacts` and `publishSealedArtifacts` are routed to it. W11's dormant owner, existing `fileProof`, mediaPreparation, flags, 0042 proposal, schema and migrations are unchanged. Fencing-OFF routes do not call the new helper. No schema/API/provenance/reclaim/retention policy was adopted.

## Acceptance decomposition

| Area | Current candidate status | Evidence / action |
| --- | --- | --- |
| W2/W4 descriptor-bound bytes/identity | SECURITY INVARIANT PASSED for exercised schedules | New tests reject pre-open, during-read and post-link pathname swaps; growth and timestamp mutation; verify exact multi-chunk proof, EIO propagation/close and empty files. Integration cases run actual shared authority for both operation kinds on SQLite/PostgreSQL. |
| Root containment | INSUFFICIENT EVIDENCE / owner policy | Final no-follow is not ancestor protection. The helper is a proof at read time, not a rooted publication capability. Stable provisioned root/ancestor ACLs remain an external prerequisite. PR #465 preserves the transient swap-and-restore counterexample. |
| F2 publication authority | VULNERABILITY REPRODUCED / HIGH FAIL | New tests intentionally expire A, reclaim B, then let A publish its original inode before any DB commit. Descriptor correction does not prevent this. Existing generation/nonce/lease DB CAS is retained. |
| Stale-owner recovery | Existing behavior preserved; not F2 closure | Existing real W2/W4 crash/retry, lost-ACK and stale-generation suites remain unchanged. No automatic reclaim policy changes. |
| Existing canonical provenance (F3) | Existing behavior unchanged / open | PR #464 classifier remains inactive; EEXIST byte-only adoption is not silently changed. Own-generation live-inode provenance needs separate reviewed scope. |
| Durability ordering (F5) | Process-death evidence only; power-loss unverified | Existing three real SIGKILL/restart cases retained. No fsync, host power-failure or backup policy claim. |
| W11 and 0042 | AUTHORIZATION BLOCKED / unchanged | Dormant W11 still uses the old helper; a retained REPRO test verifies its old path-swap defect. No integration, migration registration/application or feature activation. |

## Explicit owner choices (not applied)

- F1 filesystem model: accept provisioned stable ancestors with service ACL/identity isolation and provide deployment evidence; or require native descriptor-relative rooted publication / an isolated broker; or defer activation. 0700/0600 does not isolate malicious same-UID workers. No-follow is final-component POSIX protection; Windows relies on descriptor/named identity observations, not an ACL certification.
- F2 authority: keep current fail/release-blocked status; or authorize a separate durable non-expiring publication-intent candidate as designed/tested in PR #465. That requires immutable per-generation intent/seal binding, fresh DB-clock admission CAS, no reclaim of publishing by TTL, same-intent recovery, and hard old-worker fencing before revocation. It can block a derivative indefinitely. If that availability cost is unacceptable, require a different enforced publisher; a pre-link check or connection-held DB lock alone is insufficient.
- Integration of that policy requires reviewed W2/W4 schema/state/claimant changes and crash ordering. W11/0042 and historic independent-human-review conditions remain separately gated. AI evidence is not human sign-off.

## Verification record

Targeted command:

```sh
npm exec -w apps/api -- vitest run tests/ownedPhotoArtifactProof.test.ts tests/w2FencedOwnerRecovery.test.ts tests/w4FencedFinalizationAcceptance.test.ts tests/w2IdempotencyKeyFencingOff.test.ts tests/photoOwnershipSigkillRecovery.test.ts --reporter=verbose
npm run typecheck -w apps/api
```

The new suite preserves REPRO labels. Its Linux/PostgreSQL run contains 30 cases: 7 direct descriptor checks, 1 POSIX final-symlink/FIFO case, 1 configuration guard, 12 corrected shared-authority checks, 4 no-overwrite compatibility checks and 5 retained vulnerability reproductions (4 F2, 1 legacy W11). A green REPRO means the defect remains.

Local Windows PostgreSQL/POSIX skips are explicit. Initial SIGKILL tests failed due to a missing compiled shared dependency, then passed after building it in this worktree and using a local ignored dependency overlay; no assertion was altered. Test fixtures contain synthetic bytes only. Exact final local counts and required exact-head Photo Master results are recorded on #462/#457, not inferred from the base CI.

Photo Master adds this suite to its required PostgreSQL live-adoption job and pins candidate checkouts to the head SHA. Historical benchmark reference SHAs remain explicit. No acceptance condition is removed. Because runtime changed, the existing full API/crash/census/ext4/24MP jobs must run at the candidate head; fencing-OFF measurements still cannot substitute for genuine fenced W11 acceptance, which remains BLOCKED.

## Contribution to 5/12 and coordination

This candidate removes an actual descriptor-verification defect from the already wired W2/W4 fenced paths, while preserving the failed F2 reproduction and owner boundaries. It directly contributes bytes/inode integrity and runtime compatibility evidence to the Stage 5 acceptance matrix; it is not another generic audit-only PR.

Master #457 comment 6232077260 assigns authoritative stage-map recovery/acceptance assembly to Claude's separate session; no running status is inferred. This scope was posted to #462 for coordination. PR #464's F3/F5 helper/restart evidence is retained by stacking from its exact head; its branch is not edited. #424 comments explicitly distinguish work-package gates from original numbered stages. Until an authoritative criterion and acceptance decision are recorded, formal progress stays **4/12**, remaining **8/12**, rather than self-certifying 5/12.

NOCTELLA LOOP: OBSERVE verified base/gaps → ACT minimal W2/W4 correction → VERIFY hostile/regression/backend/Photo Master evidence → COMMIT owned Draft branch → CONTINUE with Stage 5 acceptance assembly and the explicit root/publication decisions. No merge, deploy, production flags, customer media or security bypass.
