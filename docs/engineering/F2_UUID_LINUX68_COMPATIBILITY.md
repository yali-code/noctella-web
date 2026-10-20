# F2 UUID compatibility: Linux 6.8

## Observe

Continue Draft #492 from ffbd3a8a65003c3ac8f79072292a3efb6dc3d2e2, stacked on unchanged base 32a027dc60b46a35e77352019a6df34e532f1924. The existing exact-head run 39307647796 passed all 11 jobs. Existing worktrees and parent branches are preserved. No applicable AGENTS.md or LOOP.md was found; Observe -> Act -> Verify remains the working sequence.

The user-provided read-only target report establishes Linux 6.8.0-1057-aws, UID 1000, and ENOTTY (25) for generic FS_IOC_GETFSUUID request 0x80111500 with a 17-byte buffer on both a regular file and its persistent directory. This was a prerequisite probe of the old deployed candidate, not execution of #492's packaged helper. No target access was performed here. Private identifiers, original payloads and historical operation details are deliberately excluded.

**Not established:** target filesystem type, ext4 legacy ioctl support/policy, candidate packaged-helper readiness, or any real target restart phase. Kernel version alone does not identify the filesystem. A restart, image rebuild or paid plan change is not a demonstrated kernel fix.

## Authoritative source and ABI

- [Linux v6.8 ext4 UAPI](https://github.com/torvalds/linux/blob/v6.8/include/uapi/linux/ext4.h), EXT4_IOC_GETFSUUID and struct fsuuid: 32-bit length, 32-bit flags, then flexible UUID bytes. The ioctl encodes the **8-byte header**, not the 24-byte userspace allocation. On the tested ABI the request is 0x8008662c; input length 16 and flags 0.
- [Linux v6.8 ext4 ioctl implementation](https://github.com/torvalds/linux/blob/v6.8/fs/ext4/ioctl.c), Git blob 7160a71044c88a8fe409111ec51cd597408f98f4: ext4_ioctl_getuuid reads all 16 bytes of sbi->s_es->s_uuid under its buffer lock. __ext4_ioctl dispatches directly using the opened file's superblock. This getter has no CAP_SYS_ADMIN check; the **setter** does. The kernel's security hooks may still deny the ioctl, and such denial must fail closed.
- [Linux v6.9 generic getter](https://github.com/torvalds/linux/blob/v6.9/fs/ioctl.c), Git blob fb0628e680c40f16fbee3b1b38b8bfcd70d1c980: ioctl_getfsuuid returns sb->s_uuid with its length. [ext4 superblock initialization](https://github.com/torvalds/linux/blob/v6.9/fs/ext4/super.c), Git blob 044135796f2b6ebe86e56b69f57501e7567d761b: super_set_uuid initializes that value from es->s_uuid. Thus, for ext4, both ABIs report the same full external on-disk UUID, in the same byte order.

This establishes a supported upstream Linux 6.8 **ext4** path within ordinary descriptor read privileges. It does not establish the actual target is ext4 or that its policy permits the ioctl. Native CI uses the runner kernel, not the AWS 6.8 build.

## Act: narrow compatibility implementation

The packaged helper first tries the unchanged generic ABI. Only ENOTTY permits ABI negotiation. It then calls fstatfs on the **same inherited fd 3**, requires ext4 family magic 0xef53, and issues EXT4_IOC_GETFSUUID against that descriptor. Filesystem type selects an ABI; neither f_type nor f_fsid is used as identity. Exact returned length 16, zero flags and nonzero 16-byte UUID are mandatory. Static assertions pin both structure layouts. No device opens, superblock parsing, mount-table lookup, shell command, capability elevation or privileged fallback is added.

Generic EPERM/EACCES/EIO and all other failures stop immediately. A successful but malformed generic reply stops immediately. Unsupported filesystem/type query/legacy ioctl, legacy denial or malformed/zero legacy result returns 125 without UUID output. There is no version-guessing, security-policy bypass, numeric-device fallback, hash-only evidence or configuration-provided UUID. The helper performs no storage mutation or exec in storage-proof mode. Mandatory Landlock readiness remains independent and required.

The existing stdio mapping already maps arbitrary parent descriptors into child fd 3. Tests explicitly hold extra descriptors and assert parent fd >3; no manual duplication was added. Preflight remains the launcher-provenance boundary under the trusted-runtime/confined-worker model. Per-call hashing is not added or claimed to prevent replacement races. UUID uniqueness remains a trusted-storage assumption; duplicated-UUID clones are not automatically detected.

## Complete-chain review and compatibility

Only UUID acquisition changes. There is **no new identity format**: pfs1 continues to mean the same 128-bit external filesystem UUID plus the same inode birth timestamp; the inode remains exact. Generic and ext4 records interoperate without rewriting rows. Existing numeric records are not upgraded or repaired. Confined owners still refuse them. SQLite/PostgreSQL TEXT values, schema and transaction logic are unchanged.

The reviewed chain remains:

1. The opened sealed source binds stable descriptor inode/birth to size/hash. The same descriptor supplies UUID and is checked again after the child returns.
2. T1 intent snapshots retain exact generation/owner/seal/executor/epoch and both artifact identities. Durable copy records carry the publisher copy's own UUID/inode/birth/hash/size.
3. Trusted canonical and staging roots must match the seal UUID before staging mutation. Current numeric devices must still agree for actual same-filesystem no-replace linking; no EXDEV fallback exists.
4. Fresh publisher-owned exclusive copy inodes are verified and recorded before canonical links. Sources are never published by linking their inodes.
5. Adoption requires recorded provenance, exact copy identity/bytes/size and a retained staging anchor currently sharing the canonical inode. Foreign identical bytes, missing/substituted anchors, inode reuse, wrong storage and ambiguous evidence remain refusals. Partial publication retains prior anchors; no anchor reconstruction or forced adoption is added.
6. Post-commit cleanup retains its root-UUID checks and existing narrowly owned cleanup. This task adds no automatic deletion, scan, recovery reset or cleanup expansion. Committed replay remains committed replay.
7. W2/W4 authority transfer still requires genuine exact-executor termination; no lease/timeout takeover. Existing SQLite/PostgreSQL atomic photo/outbox/T2 behavior and feature-OFF paths are unchanged.

The full chain and prior before/after evidence remain in [the restart report](F2_PERSISTENT_STORAGE_RESTART.md). Historic evidence manifests describe their original revisions, not this follow-up. APIs, IDs, storage keys, image recipe/resolution/quality, ordering, primary selection, alt text, outbox and backup contracts are unchanged.

## Verify

The new native test compiles both the archived exact ffbd helper and current helper, with syscall substitution **only inside a test translation unit**. It demonstrates baseline ENOTTY refusal and current full-UUID success, generic/ext4 byte equivalence, file and directory descriptors, parent fd >3, and fail-closed permission/access/I/O/malformed/unsupported cases. This is native compiled execution with simulated syscall outcomes, explicitly not a real Linux 6.8 host or target test. Production has no test override for the UUID backend.

The existing disposable ext4 budget CI job additionally executes the **real ext4 UUID ioctl** as the ordinary runner user on synthetic file/directory descriptors. Only generic ENOTTY is injected in that test wrapper. It compares the result with the unmodified packaged helper, and checks synthetic bytes remain unchanged. The job already creates/mounts a disposable ext4 image for existing acceptance; no additional host privilege or target resource is requested. The separate full API job runs native generic helper/publisher coverage and the simulated ABI matrix. Unsupported targets are not silently skipped: the explicit ext4 job is required.

Local Windows validation: 99 passed / 59 explicit platform/driver skips across 10 selected files; API typecheck passed; writer census/disposition 7 passed. Native execution and PostgreSQL are unavailable locally. Exact-head CI, raw native ABI transcripts, PostgreSQL W2/W4 phase checks, existing live/terminated-executor and SIGKILL regressions are reported separately in Draft #492. CI counts are not target acceptance.

Evidence is retained under [f2-uuid-compatibility-evidence](f2-uuid-compatibility-evidence), with always-upload native transcripts in the existing remount and ext4 artifacts. Original attachments and private target payloads are not published. No duplicate active full CI suites are intentionally launched.

## Bounded target prerequisite and alternatives (NOT EXECUTED)

Separate target authorization is required. Preserve the historical failed operation and all files. Before any fresh protected operation or restart acceptance:

1. Record exact reviewed source/binary provenance, UID, kernel, and descriptor filesystem type for existing trusted roots. A type report is diagnostic only, never identity.
2. If ext4, a read-only legacy UUID probe on the same ordinary file/directory descriptors can establish syscall support and matching nonzero full UUID. Do not publish private UUIDs/payloads. Stop on denial, unsupported ABI or conflicting evidence; do not change privileges/security policy.
3. Only after authorized candidate packaging and independent review, require packaged-helper/preflight/readiness on canonical, private and staging roots. A standalone Python probe alone does not establish candidate runtime readiness or birth/inode checks.
4. If prerequisites pass, follow the existing sequential fresh-synthetic W2/W4 plan: before publication, one link, both links before T2, committed lost acknowledgement/cleanup. Verify live-executor refusal, genuine shutdown/exit attestation, epoch transfer, unchanged generation, copy/anchor integrity, one photo/outbox and stable replay. Preserve every mismatch and stop; never reset the historical review row.

If the target is not ext4, or its permitted ABI remains unavailable, **target acceptance stays BLOCKED**. XFS geometry and Btrfs FS_INFO have filesystem-specific UUID interfaces in upstream [XFS](https://github.com/torvalds/linux/blob/v6.8/fs/xfs/xfs_ioctl.c) and [Btrfs](https://github.com/torvalds/linux/blob/v6.8/fs/btrfs/ioctl.c) sources; they are unimplemented alternatives requiring actual filesystem identification, privilege/identity-domain review (including subvolumes) and native tests. They are not claimed drop-in substitutes. A provider-supported suitable kernel/filesystem is another external prerequisite, not something this task can provision or obtain by restart/plan assumption. statfs f_fsid, mount IDs, labels and generic file handles alone are not proven replacement identities.

## Rollback and remaining gates

Rolling back only to ffbd restores generic-only acquisition and will fail readiness on the observed generic-unsupported target. It must not be used to resume protected writes there. An authorized rollback must disable protected writes, drain/attest executors and preserve rows, private files, copy anchors and canonical evidence before selecting a compatible reader. Rolling back to the parent additionally lacks pfs1 recovery; keep it disabled for unresolved pfs1 operations. No identity backfill, version reinterpretation or destructive reconciliation is provided.

F2 remains **1/4**, overall engineering **4/12**. Stage 2 remains open. Full protected 24-MP acceptance remains **BLOCKED**. Independent review, actual target filesystem/ABI readiness and real RC2 acceptance are required. No Render access, deployment, restart, configuration/data mutation, main merge, resource/plan/payment action, W11/0042 activation or deferred-lab use occurred.
