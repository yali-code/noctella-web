# FAZ A F3 / F4 / F5 recovery closure (#463)

Branch `audit/faz-a-f3-f5-recovery-closure`, from `60a45569e19bf11d7af67123509d04d8dea3684b`. This is offline work only:
- no live W11 writer change and no 0042 registration;
- no runtime behavior change: the new policy module is imported by no production code.

The reviews behind it are AI technical evidence. They are not the independent human review that #424 (comment 6224788307) requires.

Line references are at `60a4556`. "Codex" refers to PR #461 / #455 comment 6231632385, which reproduced F1–F4 for W11 at `bc1c91c`.

## F3: provenance of an existing canonical file (link() → EEXIST)

**Finding (VERIFIED from source; extends Codex F3 beyond W11).**
- The shared authority used by the live W2/W4 owners under fencing ON accepts *any* regular file with the sealed bytes when the canonical key already exists. Inode identity is only checked when this call linked the file itself: `services/photoOperationAuthority.ts:162-165`.
- W11 does the same: `w11FencedInstagramDerivativeOwner.ts:128-131`.

**Provenance proof (designed, tested, not wired): `services/photoPublicationRecoveryPolicy.ts` `classifyExistingCanonical`.** An existing file is adopted only if both of these hold:
1. its bytes equal the **current** seal's;
2. its `(dev, ino)` is one of **this operation's own sealed generations**.

| Outcome | When |
| --- | --- |
| `REVIEW_FOREIGN_SAME_BYTES` | Equal bytes from any other inode. This also covers the same inode number on another device. |
| `REVIEW_OWN_GENERATION_DIFFERENT_BYTES` | An own earlier generation whose bytes differ, for example a non-deterministic render across versions. |
| `REVIEW_DIFFERENT_BYTES` | Anything else. |

Recovery is not broken: the legitimate case (crash after publication, then reclaim) is still adopted.

**W2/W4 already have the data, so no schema change is needed.**
- `photo_operation_artifacts` keeps every generation's sealed `main/thumb (sha256, dev, ino)`: `db/schema.sql:1070-1085`.
- A reclaim only clears `photo_operations.seal_id`: `photoOperationAuthority.ts:81`.
- Disposable SQLite and PostgreSQL evidence (`tests/photoPublicationRecoveryPolicy.test.ts`, "F3 provenance data on real 0040"), run against the live W2 owner:
  - a crash after publication, then a reclaim to generation 2, leaves the canonical file as **generation 1's** inode, not the current seal's;
  - both generations' seals are retained, and the rule returns `ADOPT_OWN_GENERATION`;
  - a same-bytes copy with a different inode is classified `REVIEW_FOREIGN_SAME_BYTES`;
  - nothing is replaced.

**W11/0042 cannot use this proof yet (gated amendment).**
- A reclaim sets `seal_sha256/seal_bytes/seal_dev/seal_ino = NULL` (`w11FencedInstagramDerivativeOwner.ts:41`), and `photo_derivative_operation_generations` stores no seal. A prior generation's inode is therefore lost.
- Proposed 0042 amendment (not applied): add `seal_sha256 TEXT, seal_dev TEXT, seal_ino TEXT` to `photo_derivative_operation_generations`, written in the seal CAS; adopt on EEXIST only via `classifyExistingCanonical`.

**Proposed runtime change (needs review; it changes live W2/W4 fencing-ON behavior).**
- In `publishSealedArtifacts`, when `linked === false`, load this operation's artifact rows and require `ADOPT_OWN_GENERATION`.
- Otherwise call `reviewSteps(..., "existing canonical key is not this operation's publication")`.
- Store `dev`/`ino` via `lstat(file, { bigint: true })`, which also closes C10.

## F4: failure classification and root propagation

**Live fencing-OFF W11 path (VERIFIED, and Codex reproduced EIO).**
- The catch-all at `integrations/instagram/mediaPreparation.ts:168-171` turns every filesystem failure in the legacy writer (`:153-158`) into `invalid_media`, `retryable: false`. That includes EIO, ENOSPC and EACCES.
- So transient storage faults permanently fail a post today. The fencing-ON refusal (`:130`) stays retryable.

**Proposed W11 wiring (C2 / C3, gated).**
- The design-doc call sits inside that same catch.
- It also omits `canonicalRoot`, while the owner defaults to `productPhotoStaticRoot` (`w11FencedInstagramDerivativeOwner.ts:84`).

**Classification (designed, tested, not wired): `classifyPhotoOperationFailure` and `instagramErrorFor`:**

| Class | Conditions | Caller contract |
| --- | --- | --- |
| RETRYABLE | EIO, ENOSPC, EDQUOT, EMFILE, ENFILE, EAGAIN, EBUSY, EINTR, ETIMEDOUT and network errnos; PostgreSQL `08xxx`, `57P01-03`, `40001`, `40P01`; SQLite busy; `*_IN_PROGRESS`, `*_FENCE_LOST` | `processing`, retryable |
| CONFIGURATION | Missing ownership schema (SQLite "no such table", PostgreSQL `42P01`); EXDEV, EACCES, EPERM, EROFS, ENOTDIR, ELOOP; unsupported driver / driver mismatch (C1); `PHOTO_CANONICAL_ROOT_MISMATCH` (`assertSameCanonicalRoot`, C3) | `processing`, retryable, plus an operator alert. The media is not at fault, and nothing is written (fail closed) |
| OPERATOR_REVIEW | `*_REVIEW`, `*_CONFLICT`, idempotency conflict; **any unknown error** | `processing`, not retryable |
| INVALID_INPUT | Only the caller's own source stage (ENOENT, or an existing `invalid_media` from validation) | `invalid_media`, not retryable |

Applying this to the live fencing-OFF catch is a separate, reviewable change to `mediaPreparation.ts`. It is not done here.

## F5: durability contract

**Measured.**
- SQLite runs in WAL mode with `synchronous = 2 (FULL)` (`db/runtime.ts:16`, compile default, SQLite 3.53.2), so every commit is durable.
- The W2/W4/W11 file paths never fsync anything: not the private file, its directory, or the canonical directory after `link()`.
- Contrast `aiIntakePhotoStorage.ts:150-151`, which does: write, then fsync, then link, then directory fsync.
- After a power loss, a durable `committed` row can therefore point at a missing or truncated canonical entry:
  - W2/W4: a missing photo;
  - W11: C4, a terminal review.

**Supported storage.**
- One local POSIX journaling filesystem (ext4 `data=ordered`, or XFS) holding both `PRODUCT_PHOTO_DIR` and `<parent>/.product-photo-operations`.
- `link()` fails closed with EXDEV across filesystems.
- Not supported: NFS/SMB, overlay or ephemeral container layers, or write-back caches without barriers.

**Required order.** Each step must be durable before the next database transition.

| # | Step | Guarantees |
| --- | --- | --- |
| 1 | Write the private file (`wx`, 0600), then `fsync(file)`, then `fsync(generation dir)` | — |
| 2 | Seal CAS commit | `sealed` implies durable private bytes |
| 3 | `link(private, canonical)`, then `fsync(canonical dir)` | — |
| 4 | Commit CAS | `committed` implies a durable canonical entry |
| 5 | Unlink the private name | Best effort; no fsync needed |

The deletion-free recovery paths already handle every intermediate state.

**Evidence (`tests/photoOwnershipSigkillRecovery.test.ts`).**
- This is a real process death: SIGKILL, which is TerminateProcess on Windows. It is not a hook exception.
- A child process runs the live W2 owner on a disposable file-backed SQLite database, parks at the boundary and is killed:

| Kill point | Durable state after the kill | Recovery with the same token |
| --- | --- | --- |
| After seal | `sealed`; nothing published; no rows | `IN_PROGRESS` while the dead owner's lease is live; after expiry, generation 2 commits exactly 1 photo and 1 outbox event; generation 1's private evidence is kept |
| After publication | `sealed`; canonical inodes exist; 0 rows | Commits with the **same inodes**; 1 photo and 1 outbox event |
| After the SQL commit (response lost) | `committed`; 1 photo and 1 outbox event | Returns the committed photo; no new files, rows or generation |

**Not proven.** Process death leaves the page cache intact, so these tests exercise no fsync. Power-loss durability still needs host validation:
- a Linux ext4/XFS host or VM running a crash-consistency harness (dm-log-writes/dm-flakey, LazyFS, or a hypervisor power-cut);
- the ordering above implemented;
- the three kill points repeated, checking that `committed` never refers to a missing or partial file.

Remaining gaps: an actual dropped network ACK, and exhaustive multiprocess interleavings.

## C2–C13 reconciliation

Source: Claude's #456 audit at `bc52801`. The full report text is held locally and is not yet posted in #456, so items are marked against source re-checked at `60a4556`.

| ID | Status | Notes |
| --- | --- | --- |
| C2 | OPEN, BLOCKED (W11 wiring) | Catch-all `mediaPreparation.ts:168-171`; same as Codex F4. Classification proposed above. |
| C3 | OPEN, BLOCKED (W11 wiring) | `canonicalRoot` not propagated (owner `:84`); same as Codex F4. `assertSameCanonicalRoot` proposed. |
| C4 | OPEN, owner decision | A committed derivative that goes missing or changes is a terminal review (owner `:96-103`). Recommended: regenerate under a new generation only when the file is missing *and* no foreign file exists, using the F3 rule. |
| C5 | OPEN; contract specified; process-death PASS; power loss NOT RUN | Same as Codex F5. |
| C6 | OPEN, owner decision | Backups list only `product_photos` (`repositories/product-photo-backup/drizzleSource.ts:16`). |
| C7 | OPEN | `fileProof` lstat-then-reopen (`photoOperationAuthority.ts:106`); same as Codex F1, reproduced there. |
| C8 | OPEN | Publication is not fenced; same as Codex F2, reproduced there. |
| C9 | OPEN; proof designed and tested | Same as Codex F3, reproduced there. The F3 rule above extends it to W2/W4. |
| C10 | OPEN | `lstat` without `bigint`; folded into the F3 runtime proposal. |
| C11 | OPEN, gated (0042) | No 0042 down script. Proposal is in #460's report. |
| C12 | OPEN, gated (0042) | No CHECK coupling state and `seal_*`. Combine with the F3 0042 amendment. |
| C13 | VERIFIED | No PostgreSQL migration runner or ledger; SQLite creates 0040/0041 at every start. |
| D1 | FIXED in Draft #460 (CI 39016103560, 11/11) | Separate rollback-order defect. **No interference:** this branch changes no file that #460 changes except the workflow `pull_request` base list, where both add the same entry. That is a trivial textual conflict at merge time. |

## Owner and reviewer decisions

1. Apply the F3 provenance check to live W2/W4 (fencing ON only) and add `bigint` inode storage.
2. Amend the 0042 proposal with per-generation seals and C12 CHECKs, as part of the gated 0042 decision.
3. Apply the F4 classification:
   - (a) to the live fencing-OFF W11 catch, which changes today's permanent EIO/ENOSPC failures into retryable ones;
   - (b) inside the gated W11 wiring, together with root propagation.
4. Adopt the F5 fsync ordering in the shared authority and the W11 owner, then run the power-loss host validation.
5. C4 recovery policy and C6 backup scope.
