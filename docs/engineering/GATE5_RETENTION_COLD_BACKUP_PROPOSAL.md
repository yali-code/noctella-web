# Gate 5: retained evidence and limited cold backup

Owner-approved local continuation, 21 October 2026. Branch `feat/gate5-private-operation-backup-20261021`, parent implementation `69ea8ec6dec43253d43ee2157981837f77016098`, integration baseline `e14ee617855c9af5bc33c71690bcf62b0bdb5af4`. Production runtime is the separately recorded `43b9bc3af4be8ed89be35c95d59c26435485573e`; this local work is not activated there.

## Approved policy and implementation

The owner explicitly approved preserving committed W2/W4 private main/thumb derivatives AND publication anchors. Raw-original retention stays OFF. No automatic purge, age expiry or new cleanup. Disk accumulation is accepted for preparation; activation still needs a quantified storage assessment.

The historical `cleanupCommittedPublication` hook retains its identity checks and ambiguity handling but removes no files. W4's separate direct private-file unlink is removed too. W2/W4 commit ordering, confinement, fencing, executor transfer, identity/hash verification and failure handling are unchanged. No flag, schema or migration is added. Publication staging anchors and sealed private derivatives are separate inodes; canonical names and anchors share the publisher-owned inode.

Committed retry remains terminal: W2 returns the durable photo, W4 skips preparation for finalized intake. Active recovery still requires the current intent/fence, authenticated executor transfer, copy ledger, anchor identity and sealed bytes. Retention grants no authority. Existing precommit partial/legacy staging cleanup is unchanged; this policy corrects post-commit retention only. W11/0042 and 4B are untouched.

4C reference/identity checks and canonical deletion implementation are unchanged. Canonical deletion removes two names, not the retained private files, anchors or authority rows. Publisher bytes remain allocated through their retained anchors; repeated deletion removes zero names. This is not a change to accepted 4C deletion eligibility.

## Limited backup contract

`src/scripts/privatePhotoColdBackup.ts` is an explicit owner-operated local entry point from `apps/api`. It does not import the runtime DB, discover production paths/credentials, call a target, start services, upload, restore or replay. It reuses the offline bundle/copy/authority/verifier engine rather than creating a second backup implementation.

Input is a standalone cold SQLite snapshot plus the original, still-cold private and publication roots. Original physical identities must remain verifiable; copying those source roots to new inodes before capture is not an accepted provenance substitute. Output is a new exclusive local directory under an existing owner-private POSIX directory. No chmod/ACL/security setting is performed. Windows confidentiality cannot be established by this path and is refused. POSIX mode checks do not establish encryption or protection against a hostile same-UID/root process.

Capture covers the full DB, every retained sealed main/thumb found in the selected private root, and every recorded retained publication anchor. It retains authority unchanged and reopens/verifies the materialized DB and artifacts together. A manifest digest must be kept independently for subsequent verification. Result is content/evidence verification with `runnableRecovery: false`.

`requiredRetainedOperationIds` is the operator's explicit expected-retention inventory, not authority: unknown/duplicate IDs fail; required operations must have retained private evidence, and required committed operations must also have both recorded anchors. Omission of an ID does not exclude any present sealed/recorded files. Existing historical committed pairs/anchors already absent can be accepted by the old engine only outside that required set; they are not restored, recreated or claimed covered. The owner must reconcile the required set against the policy activation boundary and cold inventory. No automatic waiver or evidence-row rewrite is provided.

Required missing evidence, unknown files/ownership, unsealed content, symlink/junction traversal, inconsistent bindings, mutation and limit violations fail closed. Unknown content INSIDE selected roots blocks capture; it is not silently filtered. Canonical bytes remain the existing canonical-backup scope and are not included in this private bundle. AI staging, raw originals, worker job directories and unrelated orphans are excluded, not recoverable by this contract. The full DB still contains sensitive application/AI records and references.

Limits remain 128 MiB DB, 16 MiB/artifact, 512 MiB total payload, 4,096 files, bounded depth/nodes, 10,000 rows/authority table and 2 MiB manifest; copies/hash buffers are 64 KiB and sequential. Original hashing size checks precede the reused descriptor proof: a concurrent replacement can exceed the configured hashing limit before rejection. This requires a genuinely immutable cold source; repeated scans are observed-change detection, not live atomicity or adversarial ABA protection. Source/destination must fit within the existing limits and available capacity; no limit is raised silently.

## Concrete operator procedure — not executed here

1. Obtain separate authorization for the actual target, maintenance interval and storage location. Record exact candidate SHA, target, responsible operator and policy activation boundary. This document authorizes no target actions.
2. Establish an existing protected destination with owner-only POSIX access and approved confidentiality at rest. Record evidence of its protection/encryption and authorized readers. Existing S3 settings alone do not establish bucket privacy, encryption, immutable retention or safe full-DB handling; no full-DB S3 upload was wired. If these properties are unavailable/unverified, STOP. Do not change permissions or create a new encryption platform under this procedure.
3. Establish cold input externally: stop admission, drain and stop ALL DB/photo mutators, preparation descendants, deletion/cleanup workers and recovery executors; independently confirm no restart/other instance can write during capture. Record supervisor/process/storage evidence. A boolean flag or reference string does not prove this condition. No automated coordinator or restart-inhibition system is added.
4. Within that same stopped interval, invoke the built snapshot command below. It opens the cold source read-only and uses the existing better-sqlite3 `.backup()` API (including committed WAL contents), reserves a new destination exclusively, then sets `PRAGMA journal_mode=DELETE` on ONLY that new snapshot and closes it. It refuses remaining `-wal`, `-shm` or `-journal` sidecars, checks integrity/FKs/authority tables and returns the snapshot hash. Partial output is retained on failure; do not overwrite it. Do not copy only the source main file from a WAL database or pair an older online backup with a later file tree. Keep original private/publication roots cold through snapshot, capture and verification. The same built `snapshot` command is used by Linux acceptance after its writer exits.
5. Reconcile retained files, policy boundary and DB records; record required retained operation IDs. Old files already removed by pre-policy T2 cleanup cannot be recreated. Unexpected/partial/unsealed evidence requires review; do not delete it to obtain a passing capture.
6. Create an operator request outside the repository, without credentials, using absolute paths and short evidence-reference IDs. Example only:

```json
{
  "source": {
    "database": "/protected/cold/point-001.sqlite",
    "operations": "/data/.product-photo-operations",
    "publication": "/data/.product-photo-publication"
  },
  "destination": "/protected/backups/point-001-private",
  "recoveryPointId": "point-001",
  "quiescenceEvidenceRef": "owner-cold-record-001",
  "confidentialityEvidenceRef": "owner-storage-record-001",
  "requiredRetainedOperationIds": ["actual-operation-id"]
}
```

7. On the original-filesystem Linux host, from the reviewed candidate's built `apps/api`, with its existing runtime dependencies and packaged helper, run the following only inside the established cold interval. `PHOTO_PREPARATION_CONFINEMENT=required` and `PHOTO_PREPARATION_LAUNCHER` pointing to that candidate's built executable are required to authenticate `pfs1` evidence; no numeric-identity fallback is acceptable. The helper/kernel/filesystem must actually support persistent UUID plus birth/inode evidence. Original private/publication roots must remain on the original filesystem with identities intact; relocating copied files to another host/inode tree is not this capture prerequisite. DB snapshot bytes may be materialized separately. These explicit command-environment settings are part of the future authorized operator invocation, not changes made to production by this assignment.

```text
export PHOTO_PREPARATION_CONFINEMENT=required
export PHOTO_PREPARATION_LAUNCHER=/reviewed-candidate/apps/api/dist/bin/landlock-worker
node dist/scripts/privatePhotoColdBackup.js snapshot /cold-original/database.sqlite /protected/cold/point-001.sqlite
node dist/scripts/privatePhotoColdBackup.js capture /protected/operator-point-001.json
node dist/scripts/privatePhotoColdBackup.js verify /protected/backups/point-001-private EXPECTED_MANIFEST_SHA256
```

Use the exact reviewed build and its packaged helper; no workspace-local `tsx` executable or install is assumed. Preserve the returned capture digest outside the bundle and record all three results with prerequisite evidence. A source WAL/shm file is not itself a reason to copy loose DB files: the SQLite backup API reads that coherent cold database; only the resulting standalone snapshot is input to capture. Capture does not establish external quiescence/encryption. No paths, records or credentials are printed in CLI failure diagnostics. Partial/completed output is retained; an existing destination is never overwritten. The scoped CI builds the candidate CLI and preparation worker, not a full test suite.
8. Verification is nondestructive and authorizes no application startup, canonical overwrite, physical-identity rewrite, token reuse or executor replay. Historical restored authority remains evidence. Do not point a running application at the recovered DB. Any runnable recovery is outside this limited contract.

## Storage assessment

Let `P = main bytes + thumb bytes` per photo-operation. W4 intake finalization may contain multiple photo-operations; multiply by its photo count. One successful generation has four distinct image inodes (private main/thumb plus publisher main/thumb), and six names while canonical files exist (two private + two anchors + two canonical). Anchor/canonical pairs are hardlinks, not extra data copies. After canonical deletion, four names/four inodes remain. Directory entries, SQLite/ledger growth, allocation rounding, failed/superseded generations and filesystem metadata add overhead.

| State | Previous T2 policy | Retention policy |
| --- | --- | --- |
| Canonical photos present | `P` publisher data | `2P` private + publisher data; extra `P` |
| Canonical photos deleted by 4C | normally no image data for that committed pair | `2P` remains; anchor links keep publisher bytes alive |
| New private backup payload | no private-generation coverage | `2P` plus full DB, manifest and other retained generations; copies do not deduplicate original hardlinks |

Existing synthetic P3 ICC fixture has main 452 B + thumb 344 B = `P=796 B`; sRGB has 450 B + 356 B = 806 B. These are small synthetic patches, NOT representative production sizes. With an illustrative 4-KiB allocation unit and no compression/sparse/reflink behavior, one P3 pair allocates 8 KiB, all four image inodes allocate 16 KiB, and canonical deletion still leaves 16 KiB. This is an allocation MODEL; Windows allocated blocks were not measured. Link-count/inode relationships are checked on disposable retained-file fixtures.

For an explicitly illustrative workload, assume main 400 KiB + thumb 40 KiB (`P=440 KiB`, both 4-KiB aligned), 30 days, no failures/superseded generations and no metadata/DB overhead:

| New photo-operations/day | Extra data/day while canonical remains | Extra data/30 days while canonical remains | Data retained after all corresponding canonical names are deleted, 30 days |
| --- | --- | --- | --- |
| 100 | 42.97 MiB | 1.26 GiB | 2.52 GiB |
| 1,000 | 429.69 MiB | 12.59 GiB | 25.18 GiB |

Each full private bundle stores both private and publisher pairs. Daily full bundles retained for 30 days with 100 new operations/day under these assumptions would accumulate about 39.02 GiB of image payload across those 30 bundles, plus 30 full DB snapshots/overhead; no deduplication or automatic expiry is implemented. This is a cadence illustration, not a recommendation to schedule backups.

Current proof-sized limits are material: 4,096 files allow at most 1,023 complete four-file operations plus a DB; at `P=440 KiB`, the 512-MiB payload limit with a 128-MiB DB fits about 446 operations before overhead. Real capacity must be checked against the actual cold source. Activation needs owner-held current allocated-byte totals, existing free capacity, expected workload/backup cadence and headroom for partial/failed generations. None were scanned on production here. No disk upgrade or automatic purge is proposed.

## Evidence and acceptance boundary

Independent consumer review found no new authority from retention; independent non-authoring code/test delta review found no actionable finding within the limited cold-source contract. Earlier 20 offline cases and ICC evidence are reused where unchanged. New operational tests use simulated POSIX destination metadata on Windows and do not certify real destination protection.

Gate 5's existing definition is `Storage, restore, retention: PASS (offline) / owner choice`; row (d) covers retention, private-generation backup inclusion and cleanup. A new automated coordinator, encryption platform or authority re-establishment is NOT a mandatory gate. The earlier handoff's broader architecture requirement is superseded for this explicitly limited contract.

The remaining limited-contract acceptance is an owner-reviewed genuinely cold source and existing confidential destination, a reconciled required-retention inventory, and one successful capture plus independent-digest verification on the actual supported POSIX/persistent-identity path. Existing caps/unknown content may block that operation and must be reported without silent exclusions. Production activation separately requires the quantified capacity assessment and a release authorization for this exact candidate. No full disaster recovery, historical missing-file recovery, power-loss durability or runnable authority replay is claimed.

Draft PR #496 prepares supported-platform evidence through the single `gate5-cold-backup.yml` Linux job. Its writer invokes the exact candidate's BUILT real W2 upload and W4 finalization owners with confinement required. Their real preparation workers/publisher produce committed operations, generations, seals, intents, product photos and both anchors for each photo; no authority/copy rows are manually seeded. Original ext4 `pfs1` evidence and distinct worker/publisher inodes are verified. After those owners/workers and the sole writer process exit, it runs the same built `snapshot`/`capture`/`verify` commands above. The source database is configured WAL; the snapshot must be DELETE-mode, header bytes1/1, sidecar-free. Both owners' eight retained artifacts and full DB are included (nine files). This replaces the earlier manually seeded UUID-probe fixture, which was insufficient publisher evidence. CI alone is the Linux evidence path, pending the owner's push. It checks real POSIX destination protection and independent-digest verification, not actual production confidentiality/encryption or capacity. No previously passing suites are duplicated.

One next-action package: owner reviews/pushes the scoped candidate, then separately authorizes only its necessary PR/required-gate work and the limited owner-operated cold acceptance/capacity review described above. If accepted, request exact-candidate activation separately. No current push, remote write/merge, CI dispatch, deployment, target access, policy activation or normal-use resumption occurred. F2 CLOSED 4/4 and accepted 4C remain unchanged; W4 ICC/color acceptance OPEN; overall 5/12.
