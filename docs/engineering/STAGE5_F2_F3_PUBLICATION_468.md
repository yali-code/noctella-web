# Stage 5 W2/W4 publication closure ? #468

NOCTELLA LOOP: OBSERVE ? ACT ? VERIFY ? COMMIT ? CONTINUE.

Base: f6b11292ae2699fa4d436641fba8ab817911580a (#467). Exclusive branch: fix/stage5-w2-w4-f2-f3-publication. Stack target: fix/faz-a-stage5-w2-w4-descriptor-proof. Issue #468 assigns Codex sole implementation and Claude independent read-only acceptance; no other branch is edited. No AGENTS.md or LOOP.md was present in this checkout. This delivery does not certify Stage 5 or increment 4/12.

## Applied F3 correction

The shared W2/W4 publisher previously treated EEXIST plus equal SHA-256 as ownership. A separately copied, foreign inode could therefore become the photo's canonical file. It now calls the existing #464 classifyExistingCanonical policy using photo_operation_artifacts records selected by this operation ID. Adoption requires current sealed bytes AND the recorded device/inode of a sealed generation AND a private filename that still holds that sealed inode and hash. Identity comes from #467 descriptor-bound bigint proofs, never rounded numeric lstat identity. Generation paths are derived from the operation ID and validated positive safe integer generation, not stored relative_path input.

The current generation is proved through the actual private file passed by its owner; prior generations use the established private-root layout. ENOENT means no live provenance; other proof failures fail closed. A recorded inode whose private name vanished or was replaced cannot prove provenance, preventing inode-number reuse from authenticating a foreign file. Rejected canonical files are preserved, never overwritten or deleted. A still-current attempt enters review. A superseded attempt facing an already committed successor returns the existing 503 fence-lost behavior without altering the committed operation. This exception grants no adoption authority.

Crash-after-publish recovery remains legitimate: the dead generation's private names remain live and match its durable seal, so a later generation of that same operation may adopt the canonical links. Normal committed retries return the durable result before publication, even though successful owners remove their private links. The correction adds no schema, flags, root migration, or W11 changes.

## F2: direct W2 vulnerability reproduction, not a security PASS

w2FencedOwnerRecovery.test.ts now runs actual W2 upload A, recipe, seal, publication and photo/outbox transaction. Its deterministic afterSeal barriers do:

1. A seals generation 1; expire only this disposable test operation's lease.
2. B reclaims generation 2, renders and seals, then waits before publication.
3. A resumes and successfully links its generation-1 inode to the absent canonical name while the database remains generation 2 / sealed.
4. A's final commit CAS rejects 503; no stale SQL effects commit.
5. B resumes, adopts the authenticated generation-1 files, and commits exactly one photo/outbox event.

This is VULNERABILITY REPRODUCED / HIGH / FAIL for publication authority, even though the reproduction test is green. It also verifies that F3 provenance and current ownership are distinct: a genuine old generation is not foreign, but it is not authorized to initiate publication after reclaim. Both SQLite and disposable PostgreSQL cases exist; only executed cases count as evidence.

## F2 alternative contracts requiring an owner decision

There is no atomic transaction spanning the SQL row and filesystem link. A pre-link ownership CAS leaves a pause between CAS and link. Holding a PostgreSQL row lock across link is also insufficient if the connection dies while the process survives and resumes; #465 already proves this case. Lease expiry is not proof that an old worker lost filesystem capability.

| Contract | Ordering, recovery and progress | Cost / decision |
| --- | --- | --- |
| Durable non-expiring publication intent | T1 locks the operation (SQLite immediate / PostgreSQL FOR UPDATE), checks current generation, nonce, owner, sealed state and DB-clock lease, stores immutable intent + seal, and commits before any link. Neither TTL nor a new generation may reclaim publishing. Link only that intent's exact sealed inodes; T2 commits that same intent and SQL effects exactly once without applying the expired original lease. Lost T1/T2 responses reload the exact persisted intent. Crash resumes the same intent, including partial main/thumb links and EEXIST provenance. | Safety prevents stale-generation takeover, but a paused worker or missing private artifact can block indefinitely. An incident alert/deadline is not a safety fence. Requires an explicit owner-approved availability contract, operator procedure and schema/runtime authorization before integration. No such acceptance is inferred here. |
| Durable intent plus externally enforced bounded takeover | Same T1/link/T2 contract, but an independent supervisor or filesystem broker revokes the old process's canonical-write capability before changing intent/generation. Reconcile both canonical keys against exact seals; preserve foreign evidence; resume or review. Operator action is recorded and idempotent. | Bounded progress is conditional on a proven maximum time to revoke every old worker/capability. Requires deployment/topology, supervisor acknowledgement and exclusive root-writer decisions. Killing only a DB connection or waiting out a lease is insufficient. Outside this offline change's authorized runtime scope. |
| Sole capability-owning publication broker | Workers cannot link canonical names. A broker serializes authorization and link under one capability boundary; SQL state and retry reconciliation use immutable operation/seal identities. Broker crash recovery retains intents; replacement requires fencing the previous broker. | Larger architectural and deployment change; root ACL/native descriptor broker and singleton/failover contract must be accepted and verified. A broker using only TTL would reproduce the same race. |

Operator recovery must first prove that all publishers of the old intent have lost write capability (all relevant processes/hosts, not only the lease owner row), then inspect both canonical keys and private sealed files, adopt only matching authenticated inodes or put the operation in review, then atomically record the chosen transition and audit reason. Never delete foreign files or reset publishing on elapsed time alone. Uncertainty is review/blocked, not a new owner permitted to race.

**Exact pending decision:** choose an availability/recovery contract, name the enforcing authority and trust assumptions, approve the operator procedure and any necessary W2/W4 schema/runtime changes. This delivery does not implement a publishing state, non-expiring lock, pre-link CAS, schema migration, or bypass. F2 runtime integration is AUTHORIZATION BLOCKED; other work continues.

## Verification and acceptance interpretation

The focused suites preserve all existing assertions. Added actual-owner regressions cover foreign identical-byte main AND thumbnail files on W2 and W4, missing/replaced prior-generation private evidence, and real W2 A?B?A publication ordering. Existing recovery tests cover legitimate prior-generation adoption, lost commit response, retries, concurrent requests, no-overwrite, W4 fail-closed and fencing OFF.

Process-death coverage uses the real W2 child owner at beforeSeal (after claim/private-directory creation), afterSeal, afterPublish and afterCommit. SQLite uses a disposable file-backed database; a separate PostgreSQL suite passes only a disposable database URL and isolated schema to the child. The child is killed before the parent retries; precommit lease behavior, generation reclaim, exact-one SQL effects and published inode preservation are checked. These tests establish process-death recovery, not host power-loss durability or durable-intent protocol implementation.

Photo Master CI retains every acceptance command and threshold, adds the stacked target branch trigger, pins candidate checkout to the PR head (inherited #467), and adds the PostgreSQL SIGKILL suite to the required PostgreSQL gate. Historical reference matrix checkouts remain historical controls. Local PostgreSQL cannot execute: no Docker daemon pipe and no disposable URL. That is INSUFFICIENT EVIDENCE locally; the mandatory CI service must supply actual execution before a PostgreSQL PASS is reported. Exact-head CI results belong in the final issue report, not assumed from previous commits.

| Stage 5 criterion | Disposition before exact-head CI |
| --- | --- |
| Durable W2 request identity / generation fencing / photo + outbox atomic commit | Existing invariants retained; focused local regression PASS; PostgreSQL pending CI |
| F1 descriptor-bound byte/device/inode verification | Preserved from #467; root/ancestor containment remains conditional on stable trusted ACL-protected directories; no native root capability proof |
| F3 foreign equal-byte canonical adoption | Corrected in real shared W2/W4 publisher; focused local regression PASS; PostgreSQL pending CI |
| Legitimate own prior-generation recovery and no overwrite | Local PASS, including real process death; PostgreSQL pending CI |
| Stale-owner canonical publication authority (F2) | HIGH / FAIL, directly reproduced on real W2; safe runtime protocol AUTHORIZATION BLOCKED pending contract |
| Complete authoritative Stage 5 acceptance | BLOCKED: remain 4/12; CI success cannot turn a green vulnerability reproduction into a security PASS |

W11 remains inactive and 0042 unregistered/unexecuted. No production, staging, customer media, deployment, merge or flag activation. Master #457 comment 6232754874 prospectively permits independent AI technical review; it does not supply a missing F2 risk-policy decision or separately authorize W11/0042. Historical authorization is not rewritten or represented as prior human approval.
