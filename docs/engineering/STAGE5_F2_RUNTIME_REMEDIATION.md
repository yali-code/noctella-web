# Stage 5 F2 — runtime remediation of stale publication authority (#472)

Branch `fix/f2-runtime-remediation`, stacked on PR #486 (`feat/f2-wp1-publication-intents`, `dbefad87`). That PR is itself based on `fix/stage5-f2-capability-fenced-publication` (#471 stack, `0db5844`).

**Dependency:** this branch requires #486. Merge order: #486, then this branch, both into the #471 stack. Nothing here merges `main`, deploys, activates a flag, or touches Render or a provider.

Status:
- Runtime Photo F2: implementation complete on this branch. Acceptance is pending exact-head Linux CI, independent review, and target and release evidence.
- Official progress stays **4/12** until that acceptance exists.

## 1. What changed at runtime
With `PHOTO_OWNERSHIP_FENCING_ENABLED=true`, the real W2 owner (`uploadFencedProductPhoto`) and W4 owner (`buildFencedAiIntakePhotoFinalizationManifest`, committed by the finalization use case) now run the protected publication protocol. The vulnerable primitive `publishSealedArtifacts`, which links the worker-owned inode, has **no runtime caller**: it remains only as a negative control in tests. There is no flag that brings it back.

1. **Readiness (fail closed):** `assertPhotoPublicationReady`.
   - The intent, exit-record and copy tables must exist (0043/0044).
   - The canonical, operation-private and publication-staging roots must be directories on one filesystem.
   - Otherwise the owner returns 503 `PHOTO_PUBLICATION_NOT_READY` and writes nothing.
2. **Guarded claim:** a known operation goes through `guardedReclaimSteps`. It takes the `photo_operations` row lock, refuses while an intent is `authorized` (whatever the lease says), and otherwise uses the unchanged `claimExistingOperation`.
3. **Preparation and seal:** unchanged (generation-private directory, descriptor-proof seal, live lease).
4. **T1:** `acquirePublicationIntent` (live DB-clock lease plus current sealed generation) creates the non-expiring intent **before any canonical name exists**.
   - A superseded (stale) generation is rejected here: 503 `PHOTO_OPERATION_FENCE_LOST`, the same contract as before.
5. **Copy-owned publication:** `publishAuthorizedArtifacts` → `publishVerifiedCopy` (ported from Step 3). Per artifact:
   - Open the sealed source and require the sealed inode.
   - Copy it into a fresh publisher-owned staging inode (`<parent>/.product-photo-publication/<operation>/<artifact>/data-*`).
   - Verify sha256 and size on the publisher's own descriptor.
   - Record the copy identity in `photo_publication_copies`. This is fenced: only the current intent executor can record.
   - Only then `link()` it to the canonical key. Nothing is ever replaced.
   - The staging name stays as an **anchor** (a second link) until T2 commits. The inode therefore cannot be freed, and its number cannot be reused by a foreign file: ext4 reuses freed inode numbers and birth times are coarse. Adoption requires the canonical name and the anchor to be the same inode (dev, ino, birth time) with the sealed bytes. A missing or replaced anchor is a `COLLISION`.
6. **T2:** the existing photo + promote-outbox transaction, unchanged.
   - Its fence proof now carries `intent { epoch, token, executorIdentity }`, so `commitDrizzlePhotoOperationFenced` delegates to `commitIntentAuthorizedPhotoOperation`: the real predicates minus the lease, plus the full authority tuple.
   - W4 keeps one transaction: intake lock, product lock, each photo + outbox + fence, then intake finalization.
   - Lock order and outbox behaviour are unchanged.
7. **Cleanup:** only after commit, and only the operation's own staging namespace and private generation files.

Recovery outcomes:
- **Canonical name exists:** adopted only when it is exactly the recorded copy inode with the sealed bytes (`ADOPTED`). Anything else (`COLLISION`, `SNAPSHOT_MISMATCH`, `SOURCE_REPLACED`, `SOURCE_MISSING`) moves the operation and intent to review (409 `PHOTO_OPERATION_REVIEW`). Foreign files are never adopted, overwritten or cleaned.
- **Storage failure (ENOSPC/EIO/…):** 503 `PHOTO_STORAGE_UNAVAILABLE`. This attempt created no canonical name; the intent stays authorized and a retry resumes.
- **Lost acknowledgements:** the durable committed result is returned (W2: the committed photo; W4: the Finalized branch). Rows, events and files are not duplicated.

## 2. Trusted process authority (`photoPublicationExecutor.ts`)
- **Executor = this API process**, which is trusted code.
  - Identity: `px1:<boot_id>:<pid-namespace inode>:<pid>:<start time>:<nonce>`, from Linux `/proc`.
  - On a platform without `/proc`: `px1u:…`, which can never be authenticated.
  - Each T1 gets a fresh token registered in the process's execution registry. The token is released only when the owner's whole execution (publication **and** commit, or failure) has settled.
- **Preparer lifecycle and trust boundary.** Preparation workers are **untrusted**; this is the accepted threat model of Steps 2–4, and it is not narrowed.
  - A same-UID process that is **not** confined can overwrite published copies in place (they are mode `0600`, owned by the API UID). It can also overwrite the publisher's staging anchors and private files, reopen the API's open canonical descriptors through `/proc/<api>/fd`, and read `/proc/<api>/environ` (credentials).
  - Copy ownership, `0700` directories and the readiness ownership checks do **not** isolate such a process. The negative control in `photoPreparationConfinement.test.ts` demonstrates every one of these.
  - **Protected mode therefore REQUIRES confinement:** with fencing ON, publication is NOT READY (503) unless `PHOTO_PREPARATION_CONFINEMENT=required` and `PHOTO_PREPARATION_LAUNCHER` names an executable launcher on Linux.
  - **In-process preparation** is accepted only as an explicitly **UNPROTECTED** mode for `NODE_ENV=test` or `development`. Here the decoder runs inside the API process, so a decoder compromise **is** an API compromise and nothing is isolated. It is never a production configuration and never a fallback.
  - **Confined (`photoPreparationConfinement.ts`):** each W2/W4 preparation runs in a separate worker started through the Step 2 Landlock launcher (plain mode).
    - Writes are allowed only beneath its generation directory and a per-job directory.
    - stdio is `/dev/null` + parent sockets, verified by the launcher; every other descriptor is closed.
    - The environment carries no database URL or secret.
    - `LANDLOCK_ENFORCED` must be reported, otherwise 503.
    - The parent waits for the worker's exit (and kills it on timeout or abort) **before** sealing.
    - Descendants inherit the confinement. A surviving descendant can at most alter private bytes, which then fail copy verification (`SNAPSHOT_MISMATCH` → review).
    - What the confined worker can still do: **read** files (Landlock restricts writes only), for example the SQLite database file, which is a confidentiality limit; signal same-UID processes, which is denial of service; and produce arbitrary image bytes for its own operation, which is inherent to a preparer.
    - What it cannot do: write canonical, staging, private-of-others or database files; reopen `/proc/<api>/fd`; read `/proc/<api>/environ`; ptrace the API (Landlock's domain hierarchy).
    - Network: the worker has no credentials in its environment and cannot read the API's environment. Credentials must not be stored in files readable by the API UID; that is a release gate.
  - An invalid value, a missing value outside test/development, a non-Linux platform or a missing launcher is NOT READY (503). There is no fallback.
- **Exit authenticator.** Authority moves (epoch n → n+1, `transferAfterAuthenticatedExitSteps`, in one transaction under the row lock) only when one of these holds:
  - (a) an exit record for that exact epoch and identity already exists, written by a trusted caller; or
  - (b) the authenticator proves termination now, and the record is written in the same transaction. Proof means:
    - the same process, with the execution's token no longer registered; or
    - the same boot **and** the same PID namespace, with `/proc/<pid>` absent, a zombie, or showing another start time (PID reuse).
  - Everything else is **BLOCKED** (409 `PHOTO_OPERATION_IN_PROGRESS`): another host or container, no `/proc`, an unparseable identity, or a live process.
  - Lease expiry, a missing heartbeat and a worker-reported PID are never inputs.
- **Descendants and inherited descriptors:** the runtime executor spawns no publication children. The only process boundary is the executor itself.
- **Supervisor failure:** the API process is the executor, so its death is the event that the authenticator must prove.
- **PostgreSQL backend lifetime.** A dead executor cannot commit later:
  - commits happen only in T2, whose fence row-locks `photo_operations` before COMMIT;
  - transfer takes the same lock and therefore waits for that backend (commit → terminal; abort → transfer);
  - a dead client cannot send new statements.
- **Operator attestation** (trusted boundary, `npm run photos:publication-intents`):
  - The default is a read-only report of authorized and review intents, with `resumable` and `blockedReason`.
  - `--attest-exit --operation --epoch --executor --operator --evidence "<platform termination record>" --confirm-executor-terminated` records an operator-verified termination for one exact epoch and identity (CAS).
  - **Privilege model:** the channel is a shell with the API's database credentials, so its holder can already write any row directly. A token or signature would not stop that actor, so none is added. The tool guards against **operator mistakes**:
    - a stale epoch, a mismatched identity or a replay is refused;
    - an executor this host can see alive is refused;
    - external evidence (8–160 characters, no separators) is mandatory and stored in `attested_by`.
  - The operator name and the confirmation flag are audit labels, not proof. Without evidence the intent stays BLOCKED.
  - It is required after an instance replacement, because the runtime cannot observe the previous container. The next retry then transfers authority and resumes.

## 3. All canonical writers (`photoCanonicalWriterInventory.test.ts`)
| Writer | Path | With fencing ON | Production availability impact |
| --- | --- | --- | --- |
| W2 fenced upload | `uploadFencedProductPhoto` | **Protected publication** (this change) | Uploads require 0043/0044 and same-filesystem roots; otherwise 503. A lost executor across a restart is BLOCKED until operator attestation |
| W4 AI finalization | `buildFencedAiIntakePhotoFinalizationManifest` + use case | **Protected publication**, single finalization transaction | As W2. Any review or collision fails the whole finalization (intake stays Applied) |
| W1 legacy upload / W10 staged upload (+ rollback delete) | `products.ts` `refuseUnfencedProductUpload`; route requires `fencedUpload` | Refused (503) before any write | None while W2 serves uploads |
| Instagram prepare-image derivatives (live) | `mediaPreparation.ts` | Refused (retryable `processing`) before any write | **Instagram image preparation is unavailable with fencing ON** (publishing needs a prepared asset). Re-enabling it requires bringing derivatives under authority (W11) or moving them out of the canonical root |
| W11 fenced Instagram derivative | `w11FencedInstagramDerivativeOwner.ts` | Dormant: no runtime importer (asserted), 0042 unregistered | None (not reachable) |
| W7 distinct-root promotion | `productPhotoStorageWorkflow.ts` | Refused; same-root promotion only checks files | None in production (temp root == canonical root) |
| W8 canonical delete / W9 temp cleanup | outbox handlers | Refused permanently, dead-lettered for operator review | **Deleted photos' files remain on disk** until an operator-reviewed cleanup procedure exists |
| W6 AI cleanup canonical delete | `aiIntakeCleanup.ts` | Refused, counted as a failure | Canonical files of cleaned intakes remain |
| Operator restore | `docs/deployment/product-photo-backup-recovery.md` | Manual procedure | Restore only with uploads stopped (fencing OFF or the service stopped), and no authorized intent left (`photos:publication-intents` empty). Never restore over a key an authorized intent targets |
| Non-canonical | AI intake root, upload staging, `MEDIA_ASSET_DIR`, disposable dev tools | Unaffected | — |

## 4. Schema, compatibility, rollback
- **0044 `photo_publication_copies`** (additive, forward-only, also in `schema.sql`): PK `(operation_id, artifact)` → intent. It records the staging name, `copy_dev`, `copy_ino`, sha256, bytes and the recording epoch.
  - 0039 and 0042 stay reserved. 0043 (#486) is unchanged.
  - `photoReleasePreflight` now requires 0040, 0041, 0043 and 0044, and also checks:
    - the staging-root filesystem;
    - whether exit authentication is available;
    - a MANUAL restart-attestation step.
- **Legacy and in-flight operations** (from earlier code):
  - With no intent, the normal lease rules apply. An expired operation is reclaimed as a new generation and published by copy.
  - A canonical name a legacy owner already linked (a worker inode, no copy record) is a `COLLISION`, which goes to review. It is never adopted.
  - Committed historical worker-inode files remain valid committed data.
- **Deployment compatibility:**
  - Old and new instances must not overlap: old code would still link worker inodes. This is the existing fencing runbook requirement (old instance stopped first).
  - After a deploy, intents of the previous instance are BLOCKED until attestation.
- **Rollback:**
  - The tables are additive and inert without intents, so reverting the code is safe only when `photos:publication-intents` reports no `authorized` intents. Earlier code would ignore them and could reclaim after lease expiry.
  - Never drop 0043/0044 while intents or copies exist.
  - Turning fencing OFF re-enables the legacy unfenced writers (the pre-existing documented behaviour). It never re-enables linking worker inodes for operations that hold intents. Those operations stay sealed until review.

## 5. Acceptance matrix (required gate `w2-live-adoption-gate`, SQLite + disposable PostgreSQL, Linux)
| Requirement | Test (real runtime entry points) |
| --- | --- |
| Stale owner cannot create canonical names after reclaim | `w2FencedOwnerRecovery` "F2 REMEDIATED" (inverted REPRO) + NEGATIVE CONTROL (legacy primitive still links stale); `w4FencedFinalizationAcceptance` "F2 REMEDIATED (W4)"; 470 A→B→A: refused at T1, confinement denies a direct link and an alias |
| Active intent excludes reclaim | W4 "expired lease cannot hand an actively publishing finalization…"; Contract 1 S2/S2b; schema suite runtime decisions |
| Transfer requires authenticated termination | `photoOwnershipSigkillRecovery` afterIntent/afterPublish (real SIGKILL; Linux proven → epoch 2; elsewhere BLOCKED); `w2PublicationPostgresSigkill468` afterIntent/afterPublish; runtime suite authenticator (alive / other boot / other PID ns / killed / PID reuse); operator attestation CAS |
| Commit requires the exact current intent authority | schema suite (stale epoch → FENCE_LOST; exactly once; expired lease OK); Contract 1 |
| Bytes independent of worker inodes and aliases | runtime suite (alias + retained descriptor after publication); 470 (canonical = recorded copy, ≠ seal inode, `nlink 1`); Step 3 suite now runs on the runtime publisher (adapter) |
| Source mutation/replacement cannot publish | runtime suite `SNAPSHOT_MISMATCH` / `SOURCE_REPLACED` / `SOURCE_MISSING`; Step 3 |
| Lost acknowledgements: no duplicates | W2 lost-commit-ack; W4 lost-finalization; SIGKILL afterCommit (SQLite + PostgreSQL) |
| Partial multi-artifact recovery | runtime suite crash after record / after link; F3 private-name cases (adopt recorded copy only); Step 4 W4-4/6/9 |
| Foreign artifacts never adopted/overwritten/cleaned | W2/W4 foreign-collision and identical-byte cases; recovery-policy same-bytes replacement → review |
| Supervisor loss / unsupported prerequisites fail closed | readiness NOT_READY (schema missing, non-directory root, invalid confinement config); non-Linux BLOCKED branches; non-confining launcher refused; Step 2/4 supervisor-loss cases |
| Confined preparer lifecycle | `photoPreparationConfinement`: real launcher, enforcement reported, worker exited before seal, hostile worker denied canonical/database writes and aliases, no database URL; W2/W4 end to end in required mode (SQLite + PostgreSQL) |
| All writers respect the boundary | `photoCanonicalWriterInventory` + `photoOwnershipFencingSwitch` behavioural refusals |
| Migration compatibility and data preservation | `photoPublicationIntentSchema` (0043 onto 0041 with rows; idempotent; forward-only) + 0044 inventory; preflight |
| Resource / disk | copy-owned publication: one extra transient copy per artifact in staging (same filesystem), removed after link; ENOSPC case. Existing disk-budget gates measure the canonical filesystem, which contains staging |

## 6. Target and release procedure (owner-run; nothing executed by this change)
**Read-only inspection:**
1. Render service settings: instance count (must be 1), deploy strategy (no overlap), disk attachment, start command.
2. In a shell on the running service: `uname -r`; `ls /proc/self/ns/pid`; `cat /proc/sys/kernel/random/boot_id`; `stat -c '%d %U:%G %a' /var/data /var/data/<canonical>`; `findmnt -T /var/data`.
3. `npm run photos:release-preflight -w apps/api`.

Expected results:
- `migrations.0043`/`0044` PASS.
- `storage.publication-staging` PASS (same filesystem).
- `publication.exit-authentication` PASS on Linux.

**Disposable executable probe** (needs separate written authorization; never the canonical root):
- In `/var/data/f2-probe-<uuid>`, run a node one-liner that creates `a`, `link(a, b)`, verifies `st_dev` equals the canonical root's (stat only), reads `/proc/self/stat`, then deletes the directory.
- Acceptance: hard links work on the attached disk and `/proc` is readable.
- The Step 2 Landlock probe (ABI ≥ 3, plain-mode `LANDLOCK_ENFORCED` with a denied sibling write) is needed only before `PHOTO_PREPARATION_CONFINEMENT=required` is enabled.

**Release acceptance**, all of the following:
- exact-head CI is green;
- independent review passed;
- target items 1–3 match;
- the availability impacts in §3 are accepted by the owner (Instagram preparation and file deletion paused with fencing ON; restart → attestation);
- then a staging enablement with W2 upload, W4 finalization, a deliberate restart with attestation, and a lost-ack retry;
- then a production enablement, with explicit authorization only.

## 7. Remaining gaps (explicit)
- **Cross-instance executor loss** is BLOCKED until operator attestation, by design. The availability cost is listed in §3.
- **Instagram preparation and deletion cleanup** are refused while fencing is ON (§3).
- **Preparation confinement is mandatory in protected mode.** Production enablement needs:
  - a reviewed Render build change compiling `scripts/photo-publication-capability/landlock-worker.c` (`-Wall -Wextra -Werror`) and setting `PHOTO_PREPARATION_LAUNCHER`;
  - target Landlock ABI ≥ 3 enforcement evidence (§6 probe).

  Until then, fencing ON is NOT READY (uploads and AI finalization are refused). The preflight reports FAIL with fencing ON, and WARN with fencing OFF.
- **Power-loss durability (documented limit; not part of the accepted requirements, which cover process death):**
  - The SIGKILL/lost-acknowledgement recovery is tested.
  - The publisher fsyncs the copy, the staging directory before recording, and the canonical directory after linking.
  - Not covered:
    - the generation-private outputs are not fsynced before sealing;
    - newly created parent directories are not fsynced;
    - SQLite/PostgreSQL commit durability follows the database configuration.
  - Every resulting power-loss inconsistency fails closed:
    - a lost private file or one with changed bytes → `SNAPSHOT_MISMATCH` → review;
    - a durable link without its durable record, or a lost anchor → `COLLISION` → review.
  - No power-loss experiment was run or is proposed against production storage.
- **Closure:** F2 may be marked CLOSED only after exact-head CI, independent review, target verification, authorized staging and production acceptance. None of these is claimed here.

## 8. Independent review resolution (PR #487, reviewed HEAD 9fdcba4)
| # | Finding | Verdict | Evidence / change |
| --- | --- | --- | --- |
| 1 | "An unconfined hostile same-UID preparer can only cause collisions/DoS; integrity remains protected", with confinement optional | **CONFIRMED DEFECT** in the optional-confinement design. The reviewer's integrity claim is **false** | Same-UID code can write the `0600` copies, anchors and private files, reopen `/proc/<api>/fd` and read `/proc/<api>/environ`. The negative control in `photoPreparationConfinement.test.ts` shows all four succeed unconfined and all are denied under the launcher. Fix: confinement is mandatory with fencing ON (`photoPreparationConfinementConfig`, `assertPhotoPublicationReady`); unprotected in-process mode only for test/development; production-mode refusal test for W2 and W4 |
| 2 | Operator attestation / exit authentication could be bypassed | **DOCUMENTED LIMIT** (no in-scope bypass) + hardening | The channel requires DB credentials, which already allow arbitrary writes. Added: mandatory external evidence, refusal of a visibly live executor, and the existing exact epoch/identity CAS and one-record-per-epoch. Tests cover stale, mismatched, replayed, live-executor and missing-evidence cases. Unprovable termination stays BLOCKED |
| 3 | Directory readiness | **CONFIRMED DEFECT** (incomplete misconfiguration checks) | `photoPublicationStorageProblem` rejects symlinked or non-directory roots, private/staging roots inside the canonical root, other-owner or group/world-writable private/staging roots, a world-writable canonical root and split filesystems. Stated purpose: misconfiguration detection only, never same-UID isolation |
| 4 | Power-loss claim | **DOCUMENTED LIMIT** | The accepted requirements cover process death (tested). Power-loss gaps fail closed (§7). No defect within the claimed contract |
| 5 | Availability | **DOCUMENTED LIMIT + OWNER DECISIONS** | See §3. In protected mode these are refused: Instagram prepare-image, canonical file deletion (W8) and AI-cleanup deletion (W6), legacy W1/W10 uploads (replaced by W2), and cross-instance resume without attestation. Without the launcher build, **all** W2 uploads and W4 finalization are refused. Owner decisions: the W11/0042 approval (Instagram derivatives under authority), a deletion design under authority, the Render launcher build, and the availability policy for restart attestation. These are not security defects and are **not** claimed complete |
