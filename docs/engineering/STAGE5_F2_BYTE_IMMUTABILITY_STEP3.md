# Stage 5 F2 — Step 3/5 offline byte immutability — #472

Base: `949ce66185a288f290f0a9083ce32883d939e8cb` (PR #483 merged into #471's branch). Branch: `test/stage5-f2-byte-immutability-step3`. Test-only publisher, fixtures, one suite, required CI wiring and this document. No `apps/api/src`, migration, Render, flag or provider change. The 470 LIMIT reproduction, Step 2 authority, Contract 1 and both unwrapped F2 reproductions are unchanged and run in the same required job. The deferred step-0 lab is untouched. No AGENTS.md or LOOP.md exists in this baseline.

**Step 3 is not accepted until exact-head required Linux CI and independent review pass.** Runtime Photo F2: HIGH/FAIL. Production availability: NOT ACCEPTED. Official progress: 4/12.

## Why linking the worker's inode is insufficient
The 470 LIMIT test (and in-suite control N1) shows a confined worker that keeps a writable private hardlink alias to a linked canonical inode can change canonical bytes despite canonical path denial. Path checks, chmod, process exit, or one unchanged hash cannot fix that: the authority is the alias/descriptor to the same inode.

## Design: copy-owned publication (`apps/api/tests/f2s3/snapshotPublisher.ts`, test-only)
1. Open the sealed source; require the sealed `(dev, ino)` (provenance; replacement → `SOURCE_REPLACED`).
2. Create a **publisher-owned** staging inode `O_RDWR|O_CREAT|O_EXCL` in `<staging>/<operation>/<generation>/`, a directory no worker may write.
3. Copy, `fsync`, then hash the copy **through the publisher's own descriptor**; mismatch with the seal (sha256 or size) → `SNAPSHOT_MISMATCH`, own staging data removed.
4. Close the staging write descriptor; durably record the staged `(dev, ino, sha256)` in `manifest.json` (temp + fsync + rename + dir fsync).
5. `link()` the staged inode to the canonical name (never replace); `fsync` the canonical directory; remove the staging name → published `nlink == 1`.
6. Retry: an existing canonical name is `ADOPTED` only if it is exactly the manifest-recorded inode with sealed bytes; anything else is `COLLISION` (never overwritten or deleted). Incomplete or unlinked copies are discarded and recopied, never reused.
7. Cleanup ownership: only `data-*` names inside the operation's own staging namespace. Never canonical, source or worker-private names.

**Snapshot integrity** = the staged copy equals the seal and came from the sealed inode. It does not require the source to stay unchanged. **Post-publication byte immutability** = after publication no worker holds or can obtain a write path to the published inode. These are asserted by separate cases.

## Threat model and trust assumptions
- **Worker**: stale or compromised code with the Step 2 authority profile — started by the Step 2 launcher (Landlock ABI ≥ 3, `no_new_privs`, validated fd 0–3, fds ≥ 4 closed), same UID, holding its private source, retained read/write descriptors to it and hardlink aliases of it.
- **Trusted**: the publisher process and test parent (unconfined, outside the worker's Landlock domain); they never pass descriptors to workers.
- **Remaining worker write paths to the published inode, and why each is closed** (each is a test): opening canonical for write/append/truncate (Landlock `WRITE_FILE`, `TRUNCATE`); `truncate(path)`; hardlinking canonical into a writable directory (Landlock `REFER` rule: the destination may not grant more rights); renaming/unlinking in the canonical directory (`MAKE_*`, `REMOVE_FILE`); the publisher's open staging descriptor through `/proc/<pid>/fd` (Landlock ptrace scoping, Step 2); inherited descriptors (Step 2 closure). Write-capable operations without a write descriptor (`fallocate`, reflink, `copy_file_range`, writable `mmap`) all require one.
- **Not protected (documented limits)**: metadata — Landlock ABI 3 does not handle `chmod`, timestamps or xattrs, so a worker can change the mode or times of the published file (case PI shows chmod succeeds yet still grants no byte write). Any **unconfined** same-UID process can write the published bytes (control N2): immutability holds only if every worker is confined (Step 2 A1–A5 apply, including the spawn-service assumption). Single host; no concurrent publishers (serialization is Contract 1's subject); no power-loss durability claim.

## Acceptance matrix (`apps/api/tests/publicationByteImmutabilityStep3.test.ts`; deterministic IPC barriers, no sleeps)
| ID | Case | Expected |
| --- | --- | --- |
| N1 | Control: link the worker's own inode | Confined worker alias write changes canonical bytes (detection works) |
| N2 | Control: unconfined same-UID process after chmod 0444 | chmod back + write succeed (copy/chmod alone are not immutability) |
| PI | Copy-owned publish; confined worker with retained fd + alias + source replacement; all canonical attacks | Published inode ≠ source inode; source writes succeed but never reach published bytes; link/open r+/w/a/truncate/rename/unlink denied; chmod succeeds (metadata limit) but open-for-write still denied; worker holds no fd to the published inode; sha == seal; same recorded inode; `nlink == 1` |
| PF | Worker targets the publisher's live staging write fd via `/proc` | Denied; publication still correct |
| SI1 | Source mutated after seal, before copy | `SNAPSHOT_MISMATCH`; nothing published; staging data removed |
| SI2a | Not-yet-copied region mutated mid-copy | `SNAPSHOT_MISMATCH` |
| SI2b | Already-copied region mutated mid-copy | Published bytes == seal; source differs |
| SI3 | Source replaced (different / identical bytes) | `SOURCE_REPLACED` (provenance) |
| SI4 | Source truncated mid-copy | `SNAPSHOT_MISMATCH` |
| SI5 | Source mutated after verification | Published bytes == seal |
| CR ×6 | SIGKILL of the publisher process at staging-created, copy-partial, copied, verified, manifest-written, linked | Canonical absent until linked; retry → `PUBLISHED` (or `ADOPTED` after linked, same inode); sha == seal; `nlink == 1`; staging holds only `manifest.json`; worker names untouched |
| ID | Repeated publication | `ADOPTED`, same inode |
| CL ×2 | Pre-existing foreign canonical file (different / identical bytes) | `COLLISION`; foreign inode and bytes untouched; own staging data removed |
| CL2 | Foreign file appears between manifest and link | `COLLISION`; foreign file and source untouched |

## Evidence status
Local host: Windows 11, no Linux and no C toolchain — **no native case executed locally**. A scratch, uncommitted Windows logic smoke of the publisher state machine (directory fsync shimmed; interruption by exception, not SIGKILL; no Landlock) reproduced the expected outcomes and found one real defect fixed before commit (the staging inode was opened write-only, so verification could not read it back). That smoke is not evidence. Native evidence requires the required `w2-live-adoption-gate` job with `F2_CAPABILITY_REQUIRE_LINUX=1` and zero skips.
