# Stage 5 strong publication authority — #470

NOCTELLA LOOP: OBSERVE → ACT → VERIFY → COMMIT → CONTINUE.

Base: `7984ddad7d3afab9c95f58978931717480d1f1ad` (#469). Exclusive branch: `fix/stage5-f2-capability-fenced-publication`. Stack target: `fix/stage5-w2-w4-f2-f3-publication`. No AGENTS.md or LOOP.md is tracked in this baseline. Codex is sole implementer; separate Claude acceptance is requested after Draft delivery.

Owner Option B is accepted as the safety objective. Contract 0 / tolerated stale publication is rejected. **This limited delivery does not close runtime F2 or promote 4/12 to 5/12.** It fixes the independently identified recovery classification defect and supplies an enforceable offline worker-confinement proof. It does not silently install a broker, a publishing state or an indefinite intent.

## Observed execution boundary and exact integration blocker

`w2FencedProductPhotoOwner.ts:95` and `w4FencedFinalizationOwner.ts:95` call `publishSealedArtifacts` directly in their API process. `photoOperationAuthority.ts` performs the filesystem link with that process's ambient privileges. There is no separate broker, pre-exec confinement, publication-specific OS principal, or supervisor revocation receipt in these paths. Generation/nonce/lease fencing controls SQL seal/commit; it does not remove a surviving process's write capability.

`render.yaml:24` and `render.production.yaml:39` start the Node API directly and attach `/var/data`; the production artifact describes one API instance. They do not establish canonical/private directory ACL ownership, a broker principal, or cross-process fencing. Source inspection found no canonical-directory chown/setuid/Landlock policy. Actual deployed UID, ACLs, kernel support and process inventory were not inspected or changed: **INSUFFICIENT EVIDENCE**, not assumed enforcement.

`index.ts:24` invokes `createGracefulShutdown`: admission closes, HTTP requests drain, the database closes, and a 25-second timer may exit the process. The operation claim/reclaim path does not wait for a confirmed old-process exit. A paused request can retain write access before exit. Render documents SIGTERM followed by SIGKILL after the configured delay; persistent disks also change deployment behaviour. Neither a documented platform delay nor an HTTP drain proves capability revocation before a database generation transfer. [Render deployment lifecycle](https://render.com/docs/deploys), [persistent disk constraints](https://render.com/docs/disks).

**Unsafe integration stopped:** confining an async JavaScript function does not isolate its API process; applying confinement to already-running Node threads is not the pre-exec boundary proved here. Restricting the whole current API would also break existing canonical writers/fencing-OFF compatibility. The runtime needs an explicitly authorized process/topology split, enforced filesystem policy and a supervisor that covers every capability owner. Option B does not itself authorize those deployment/security-policy changes. No Render artifact, runtime entrypoint, feature default, migration or production process is modified.

## Precisely limited offline prototype

`scripts/photo-publication-capability/landlock-worker.c` is a test launcher, never imported by runtime code. It uses unprivileged Linux Landlock before exec/Node threads, requires ABI >= 3, sets no_new_privs, closes inherited descriptors above the test IPC channel, and denies handled filesystem mutation outside explicitly supplied disposable private/work/database directories. It refuses root execution and unavailable controls; it never falls back to an unconfined worker. No sudo, setuid provisioning, host ACL change, paid service or privileged host control is used.

The [kernel Landlock contract](https://docs.kernel.org/userspace-api/landlock.html) makes restrictions irreversible and inherited by descendants. Existing writable descriptors are a separate concern; the launcher is created with pipes/IPC only and closes remaining descriptors before exec. This prototype handles filesystem mutation, not every metadata operation or a complete IPC/network threat model. Kernel-backed restrictions are not a substitute for verifying deployment and all inherited descriptors.

`publicationCapability470.test.ts` invokes the **actual W2 owner** and **actual W4 manifest publisher** in the confined child, on file-backed SQLite or isolated disposable PostgreSQL through 0041. Deterministic schedules:

1. A renders/seals and pauses. B expires/reclaims that operation, renders/seals generation 2 and pauses before publication.
2. A resumes, with either its DB connection intact or its DB runtime explicitly closed. Its real canonical link must fail with a kernel denial; both canonical names must remain absent. A also attempts an alias from its allowed directory through a symlink to canonical: that must fail too. Same-UID confinement is checked.
3. The trusted **test parent** kills/reaps the exact known child, then lets B publish. Publication must match B's stored seal and reach bounded test progress. Real W2 commits/retries exactly once. W4 covers its actual manifest-publication owner; its final SQL transaction remains covered by the existing full-finalization suite, not falsely attributed to this child test.

A second drill starts the exact known **unconfined** child holding canonical capability, pauses it after seal, kills it and observes exit **before** expiring/reclaiming and starting B. This is actual process death, not DB connection release. The test has a 5-second revocation deadline and 15-second progress deadline; failure blocks transfer. These are measured fixture bounds, not a production SLA.

**What this proves:** under the fixture's startup/FD/root assumptions, a confined stale W2/W4 worker cannot publish through the real link path even after lease expiry or DB shutdown. A trusted fixture supervisor can revoke one known child's capability by observing its death and then make progress.

**What this does not prove:** deployed worker confinement; revocation of an arbitrary process, escaped descendant, unknown host or broker; root containment of the unconfined test parent; durable broker-intent T1/T2 transactions; production crash recovery/topology or availability. The test parent is a trusted authority surrogate, not an implemented publication broker. The known-child kill drill cannot be generalized into proof that all real writers are dead.

The original real W2 A→B→A vulnerability test is retained unchanged, alongside the shared publisher reproduction. It must still reproduce on the unconstrained runtime. The new negative gates are explicitly named **PREVENTED offline**; they do not relabel that runtime FAIL as PASS. No existing assertion is removed or weakened.

## Safe runtime correction: recovery-to-review

The F3 history proof previously propagated identifiable non-live private evidence as repeated generic errors. In `ownSealedGenerations`, only ENOENT, ELOOP, PHOTO_ARTIFACT_NOT_REGULAR and PHOTO_ARTIFACT_CHANGED now mean no live provenance. If no other authenticated live generation can authorize the canonical inode, the existing policy transitions the current attempt to review and returns 409. Canonical bytes/evidence remain untouched.

EIO, ENOSPC and unknown failures still propagate, leave the sealed state available for retry/diagnosis, and cannot authorize adoption. DB failures are outside this file-proof catch. This is not a broad catch-all or an F4/W11 policy integration. Tests exercise symlink, real FIFO, detected in-place mutation, EIO, ENOSPC and unknown error on both operation kinds/backends.

Mixed-generation main/thumb adoption is intentional after partial publication: each artifact independently needs this operation's durable sealed device/inode, a live private name and the **current artifact's** sealed hash. It does not promise a single-generation pair, point-in-time snapshot, or F2 authority. A new partial-publication/retry test proves main from generation 1 and thumb from generation 2 without overwrite.

## Owner-ready production dependency and recovery contract

The remaining decision is specific topology/enforcement authorization, not whether to tolerate stale publication. Before any runtime wiring:

1. Approve a process boundary that confines every preparation/request worker **before Node starts**, leaves canonical publication exclusively with a trusted broker, preserves fencing-OFF routes safely, and inventories all host/process writers. Verify the actual kernel/UID/ACLs and inherited FDs. A same-UID chmod or cooperative flag is insufficient. Signal/IPC attacks and private-seal mutation need an enforced trust model, not an assumption that workers cooperate.
2. Approve a trusted supervisor and anti-split-brain contract. Broker replacement is forbidden until the old broker **and all capability-bearing descendants/hosts** are confirmed revoked. A DB lease, lock loss, connection death, PID supplied by a worker, elapsed deadline or health check is not revocation evidence. Use stable supervisor-held process handles/identity; no PID-reuse inference. If revocation cannot be confirmed within the operational bound, refuse transfer and raise a bounded incident/escalation. Do not pretend that an alert guarantees progress.
3. Implement durable operation/generation/nonce/seal-bound intent in a separately reviewed W2/W4 schema change (not 0042). T1 uses SQLite immediate/PostgreSQL row serialization and DB time to admit the current sealed request, persists an immutable intent before link, and releases the connection. Only the capability-owning broker may execute it. A lease expiry cannot independently grant a second broker permission.
4. On broker restart after proven revocation, reload/reconcile that exact intent. For each partial main/thumb link, adopt only the operation's authenticated live sealed inode matching current bytes; foreign/uncertain evidence goes to review without deletion. Resume the same immutable request, or record an authorized abandonment/review decision after fencing. Generation/epoch transfer and its revocation receipt must be durable and idempotent. Do not reset publishing on TTL alone.
5. T2 atomically commits photo/outbox effects and that intent exactly once. Lost T1 ACK reloads the exact immutable intent; absent/unknown authoritative state grants no link. Lost T2 ACK reloads committed result without relinking. Crash before/after each DB commit and between main/thumb links requires real process-death tests on both drivers. **This broker-specific T1/T2 protocol is not implemented or executed in this limited prototype**; existing SQL lost-ACK/SIGKILL evidence cannot substitute for it.
6. Approve the availability bound and enforcement mechanism on the target environment, then independently validate under the actual supervisor and directory model. Permanent unresolvable publishing is rejected; confirmed capability revocation and recovery are mandatory. No production infrastructure is provisioned by this document.

## Evidence interpretation

Focused local Windows execution, required Linux/SQLite/PostgreSQL CI, exact head and full Photo Master results are reported on #470/#457 after CI. Windows does not execute native Linux or unavailable PostgreSQL cases; skips are explicit. Required Linux CI compiles the launcher without privilege and requires actual negative gates plus PostgreSQL, without dropping existing acceptance commands. Existing no-overwrite, provenance, lost-response/idempotency, four SQLite/four PostgreSQL SIGKILL boundaries, W4 fail-closed, fencing-OFF, ENOSPC and memory suites remain.

| Invariant | Delivery disposition |
| --- | --- |
| Identified recovery evidence errors reach review; transient/unknown errors remain failures | Safe runtime correction; source/adversarial verification required |
| F1 descriptor proof and F3 provenance/no-overwrite | Preserved; root contract remains conditional |
| Confined offline stale W2/W4 worker cannot publish | Kernel-backed negative prototype gate; actual Linux execution required before PASS |
| Known child capability revocation before fixture replacement | Offline bounded process-death drill; not deployed supervisor proof |
| Current unconstrained W2/W4 stale publication | HIGH / FAIL; original reproduction retained |
| Complete broker, durable intent, all-writer revocation and deployed root trust | AUTHORIZATION BLOCKED / INSUFFICIENT EVIDENCE; exact dependencies above |
| Official Stage 5 / FAZ A | BLOCKED; remain 4/12 until original F2 and authoritative acceptance actually pass |

No W11 activation, 0042 registration/application by new code, merge/deployment, staging/production mutation, customer-media change, paid infrastructure or privileged host change. Existing proposal-only CI schema tests remain unchanged in disposable schemas; no runtime migration execution is authorized. Request independent non-authoring Claude source/diff/security acceptance; do not self-certify this implementing report.
