# Gate 5 limited retention/backup release package

Prepared 21 October 2026. This is a proposal, not authority to operate production.
Runtime candidate: **486639e755dca2e1c29c6530e6133f3a07094b89** on
`feat/gate5-private-operation-backup-20261021`, base
`e14ee617855c9af5bc33c71690bcf62b0bdb5af4`. A later documentation-only
commit does not acquire this candidate's exact-head CI evidence.

## Existing exact-head evidence (no rerun)

[Run 39659880724](https://github.com/yali-code/noctella-web/actions/runs/39659880724),
attempt 1, job `linux-cold-cli` / 119429808867: SUCCESS,
21 October 2026, 19:14:32–19:16:26 UTC. Exact PR-head guard, build,
API typecheck, confined helper, actual CLI and scoped suites passed.

| Existing suite | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| photoCanonicalDeletion4C | 9 | 8 | 0 |
| photoColorEvidence | 1 | 0 | 0 |
| privatePhotoOfflineBackup | 23 | 0 | 0 |
| w2FencedOwnerRecovery | 16 | 17 | 0 |
| w4FencedFinalizationAcceptance | 17 | 18 | 0 |
| Total (109 cases) | **66** | **43** | **0** |

All 43 skips are PostgreSQL-related: 8 deletion cases, 16 W2 cases,
17 W4 cases and two PostgreSQL-configuration sentinel cases. No disposable
PostgreSQL service/URL was configured; none is claimed accepted by this run.
The complete verbatim skip inventory is in the companion CI record.

Artifact 12372843041, `gate5-cold-cli-486639e755dca2e1c29c6530e6133f3a07094b89`,
contains `acceptance.json`, `scoped-tests.json`, `independent-manifest.sha256`.
Downloaded ZIP SHA256 matches GitHub's recorded digest:
`64ca3d97884b6e83f8adf22167b3345dbf1579218a2d51837c83ee1ec23d3987`.
Artifact expiry: 4 November 2026, 19:16:25 UTC; retain evidence before expiry.

Actual built W2 and W4 owners used real confined preparation/publisher paths
on disposable ext4: committed authority, real `pfs1` identities and both
anchors per photo, not copied inode evidence. Writers and preparation children
ended before snapshot. The committed WAL marker was absent from the loose
main-file negative control and present in the standalone snapshot/recovered
DB. A read-only guard prevented checkpointing; it was not a writer.
The built snapshot command produced 2,293,760 bytes, DELETE mode, no sidecars,
SHA256 `7c4f5193bf8fb27b5a91dbf145eed533557c4f171219c502cba7cf30b664d8f8`.
Capture and verify covered nine files (full DB plus eight retained artifacts).
Independently retained expected manifest digest:
`2c53b88f9e9f04309605d9940e4ef3eb94d395bff025e34f6066643c468a6f9a`.
Verification integrity was `ok`, `runnableRecovery:false`. Public POSIX
destination, wrong external digest and corrupted artifact were refused.
The digest is retained outside the bundle; this is not an independent human
review or a separate administrative trust domain.

**Supported-platform synthetic offline acceptance: PASS.** No production
capacity, encryption, live quiescence, durability or runnable restore is
proved. Final Claude/Copilot sign-off is **PENDING**, not inferred from green CI.

## Owner capacity collection: read-only Render Shell

Run only after separate target-read authorization, from the actual API working
directory. Confirm current service, commit and persistent mount privately;
the previously recorded service is `srv-db34390m7kps73cv8l6g` and production
runtime `43b9bc3af4be8ed89be35c95d59c26435485573e`. Stop on a mismatch until
the owner reconciles it. Never print connection strings or customer paths.
Windows C: free space (approximately 10 GB) says nothing about Render capacity.

The following aggregate scan reads metadata only; it follows no symlinks,
imports no application module, creates no files and opens no database. It
must finish without errors; a changing live tree is only an indicative sample.
Repeat within the authorized cold interval only if live changes invalidated it.

```bash
node <<'NODE'
const fs=require('node:fs'), path=require('node:path');
const c=path.resolve(process.env.PRODUCT_PHOTO_DIR || 'uploads/product-photos');
const roots={canonical:c,private:path.join(path.dirname(c),'.product-photo-operations'),publication:path.join(path.dirname(c),'.product-photo-publication')};
const inodes=new Map();
for(const [label,root] of Object.entries(roots)) {
  const top=fs.lstatSync(root,{bigint:true});
  if(!top.isDirectory() || top.isSymbolicLink()) throw Error('Invalid root');
  const v=fs.statfsSync(root,{bigint:true});
  let names=0, dirs=0, logical=0n; const seen=new Set(); let allocated=0n;
  const walk=p=>{
    const s=fs.lstatSync(p,{bigint:true});
    if(s.isSymbolicLink()) throw Error('Symlink: assessment incomplete');
    if(s.dev!==top.dev) throw Error('Nested mount: assess separately');
    const k=s.dev+':'+s.ino;
    if(!seen.has(k)){seen.add(k);allocated+=s.blocks*512n;}
    let a=inodes.get(k);
    if(!a){a={bytes:s.blocks*512n,links:s.nlink,names:0,roots:new Set(),file:s.isFile()};inodes.set(k,a);}
    a.roots.add(label);a.names++;
    if(s.isDirectory()) {dirs++; const d=fs.opendirSync(p); try {let e;while((e=d.readSync()))walk(path.join(p,e.name));} finally {d.closeSync();}}
    else if(s.isFile()){names++;logical+=s.size;}
    else throw Error('Special file: assessment incomplete');
  };
  walk(root);
  const ops=label==='canonical'?null:fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).length;
  console.log(JSON.stringify({root:label,device:String(top.dev),filesystemBytes:String(v.blocks*v.bsize),availableBytes:String(v.bavail*v.bsize),allocatedUniqueBytes:String(allocated),logicalBytesAcrossNames:String(logical),fileNames:names,directories:dirs,operationDirectories:ops}));
}
let union=0n,shared=0n,external=0;
for(const a of inodes.values()){union+=a.bytes;if(a.roots.has('canonical')&&a.roots.has('publication'))shared+=a.bytes;if(a.file&&a.links>BigInt(a.names))external++;}
console.log(JSON.stringify({unionAllocatedBytes:String(union),canonicalPublicationSharedBytes:String(shared),filesWithLinksOutsideInventory:external}));
NODE
```

Per-root allocations overlap: use the unique union, not their sum. Linux
`st_blocks*512` measures allocation; names/logical bytes do not. Shared anchors
keep publisher bytes allocated after canonical deletion. Directory counts are
operation-directory counts, **not proof of committed or complete operations**.
External links, filesystem quotas, reserved space and other application data
need reconciliation; filesystem available space alone is not a quota guarantee.

For DB counts/workload use the confidential standalone snapshot made below,
not an online mutating DB. Set `SNAPSHOT` to that absolute path. This reads only
the copy and prints aggregates; it neither imports runtime config nor migrates.

```bash
node <<'NODE'
const D=require('better-sqlite3'); const db=new D(process.env.SNAPSHOT,{readonly:true,fileMustExist:true});
try {
 db.pragma('query_only=ON');
 console.log(JSON.stringify({operations:db.prepare('SELECT kind,state,count(*) AS count FROM photo_operations GROUP BY kind,state').all()}));
 console.log(JSON.stringify({generations:db.prepare('SELECT state,count(*) AS count FROM photo_operation_generations GROUP BY state').all()}));
 console.log(JSON.stringify({sealed:db.prepare('SELECT count(*) AS pairs,sum(main_bytes+thumb_bytes) AS logicalPairBytes FROM photo_operation_artifacts').get()}));
 console.log(JSON.stringify({committedByDay:db.prepare("SELECT date(updated_ms/1000,'unixepoch') AS utcDay,kind,count(*) AS count FROM photo_operations WHERE state='committed' GROUP BY utcDay,kind ORDER BY utcDay DESC LIMIT 60").all()}));
} finally {db.close();}
NODE
```

Reconcile file inventory against committed policy-boundary operation IDs and
both anchors, not just counts. Aggregate commit-day history is available
workload evidence, not a forecast, request-rate log or proof of complete
historical activity. Include snapshot timestamp and observation window.

**Capacity decision presently BLOCKED: no actual Render measurements supplied.**
Use measured pair sizes, retained generations, failed/partial generations,
current DB/other usage, expected operations/day, horizon, backup count/cadence
and required reserve. Reserve must cover peak snapshot + full bundle + failed
partial output alongside continued retention. Canonical-present growth is
roughly extra `P`/operation; after canonical deletion `2P` remains. Each full
bundle adds roughly `2P` per covered operation plus full DB/metadata. Allocation
rounding and directories add more. At illustrative `P=440 KiB`, 100 ops/day,
30 days: 1.26 GiB extra while canonical exists, 2.52 GiB retained after deletion;
30 daily full bundles total about 39.02 GiB image payload. These are assumptions,
not Render measurements or an approved cadence. There is no expiry/purge.
Existing capture limits (128 MiB DB, 16 MiB/file, 512 MiB payload, 4096 files,
10000 rows/authority table, 2 MiB manifest) must also fit actual inventory;
free disk does not waive them. No activation recommendation before this review.

## Ordered operational proposal (not executed)

1. Owner confirms target, exact runtime candidate above, capacity/horizon/reserve,
   existing confidential destination, policy activation boundary and retained
   operation inventory. Obtain pending Claude/Copilot results and resolve actual
   findings. Owner alone pushes; separately authorize any PR/merge/release work.
2. Authorize a maintenance interval. Stop admission and drain all requests;
   stop W2/W4, recovery/preparation descendants, cleanup/deletion/outbox and
   every DB/photo writer. Inventory the hourly photo-outbox cron and ALL other
   cron/scheduler/manual dispatch sources. Authorized operator suspends their
   scheduling/dispatch, drains already-started work and records previous states.
   Zero due/Processing events and zero authorized intents are necessary evidence,
   not proof that a cron cannot start later. If restart/cron/other-instance
   inhibition cannot actually be established, STOP. A caller flag is insufficient.
   This assignment makes no lifecycle or environment changes.
3. Under that cold interval preserve the existing canonical backup and DB
   backup/restore-verification evidence for THIS point (prior 4C backup is
   historical). Capture the limited private bundle below. Keep original
   private/publication files on their original filesystem; do not substitute
   copied inodes. Verify canonical coverage separately. Missing/unknown evidence
   or limits stop the operation; do not delete files/rows to make it pass.
4. Only with separate deployment authorization deploy the exact runtime SHA,
   not a moving branch or this package's docs-only successor. Confirm packaged
   CLI/helper and dependencies came from that build. Render events/service logs
   must show old instance fully stopped BEFORE any new instance starts; record
   both timestamps/instance IDs. Keep mutations/cron inhibited until accepted.
5. From `apps/api`, verify the actual service/SHA, SQLite, fencing ON,
   `PHOTO_PREPARATION_CONFINEMENT=required` and executable built
   `PHOTO_PREPARATION_LAUNCHER`; then existing `npm run photos:release-preflight`.
   Require real persistent `pfs1` support and no failure. Its minimum free-space
   threshold is not the quantified capacity approval. Do not rerun F2/4C suites.

   ```bash
   test "$RENDER_SERVICE_ID" = srv-db34390m7kps73cv8l6g &&
   test "$RENDER_GIT_COMMIT" = 486639e755dca2e1c29c6530e6133f3a07094b89 &&
   test "${DATABASE_DRIVER:-sqlite}" = sqlite &&
   test "$PHOTO_OWNERSHIP_FENCING_ENABLED" = true &&
   test "$PHOTO_PREPARATION_CONFINEMENT" = required &&
   test -x "$PHOTO_PREPARATION_LAUNCHER" &&
   npm run photos:release-preflight
   ```
6. Minimum owner-authorized production retention acceptance: one isolated test
   W2 upload and one W4 finalization on designated disposable products. Record
   committed DB operations/intents/seals/copies, private main/thumb and both
   anchors with expected identities/hashes; canonical/anchor link identity and
   separate private inodes. Idempotent retry must create no extra effect/files.
   Re-establish the cold interval and capture/verify a point requiring these IDs.
   No production canonical deletion test is required: accepted 4C is reused.
   Record capacity delta, failures and verification digest. This is a future
   scoped target acceptance, not a claim that synthetic CI proves production.
7. Owner reviews results and separately decides scheduler restoration and release
   scope. Preserve prior cron settings, outstanding work and partial backups.
   W11/0042 stays blocked, 4B parked; normal use remains paused. No automatic
   counter advancement: F2 CLOSED 4/4, overall 5/12, W4 ICC visual acceptance OPEN.

## Executable confidential-destination procedure

Run only inside the authorized cold interval on the original-filesystem Linux
host, using the reviewed built API. The owner must select an **existing**
protected writable destination and separately retained evidence/digest location;
neither is approved by this document. Verify actual at-rest protection,
authorized readers, mount/backing-store provenance and confidential transport
before any remote copy. Mode bits alone do not prove encryption. If these
facts cannot be established, STOP; do not use public temp/artifacts or assume
an S3 adapter supplies confidentiality. No new encryption platform is required.
The reviewed build/helper must already be available on that original-filesystem
host before a pre-deploy capture. If not, report that operational prerequisite;
do not silently run the old production build's nonexistent new CLI or copy
private roots to another host. Existing canonical `photos:backup`, DB
`db:backup` and nondestructive `db:restore-verify` procedures are documented in
[the accepted 4C release record](4C_PRODUCTION_RELEASE_PROPOSAL.md); their earlier
successful outputs are historical and do not cover a new maintenance point.

Set absolute `PROTECTED`, `EVIDENCE`, `SOURCE_DB`, `OPERATIONS`, `PUBLICATION`,
`PHOTO_PREPARATION_LAUNCHER`, unique simple `POINT`, and evidence-reference IDs
`COLD_REF`, `CONFIDENTIAL_REF`. Set `REQUIRED_IDS_JSON` to the owner's reconciled
JSON array (must include the activation-boundary/test operations). Paths are
explicit, never discovered through production connection strings. Both parent
directories must already exist, be owned by the current UID, have no group/other
permissions and be non-symlink directories. No chmod/ACL changes are authorized.

```bash
set -euo pipefail
set -o noclobber
umask 077
export PROTECTED EVIDENCE SOURCE_DB OPERATIONS PUBLICATION POINT COLD_REF CONFIDENTIAL_REF REQUIRED_IDS_JSON
export PHOTO_PREPARATION_CONFINEMENT=required PHOTO_PREPARATION_LAUNCHER
node <<'NODE'
const fs=require('node:fs'),p=require('node:path');
for(const k of ['PROTECTED','EVIDENCE','SOURCE_DB','OPERATIONS','PUBLICATION','PHOTO_PREPARATION_LAUNCHER'])if(!p.isAbsolute(process.env[k]||''))throw Error('Absolute path required');
for(const k of ['PROTECTED','EVIDENCE']){const s=fs.lstatSync(process.env[k]);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Existing private parent required');}
if(!/^[A-Za-z0-9_-]+$/.test(process.env.POINT||''))throw Error('Unique point required');
fs.accessSync(process.env.PHOTO_PREPARATION_LAUNCHER,fs.constants.X_OK);
const ids=JSON.parse(process.env.REQUIRED_IDS_JSON);if(!Array.isArray(ids)||!ids.length)throw Error('Reconciled IDs required');
const r={source:{database:p.join(process.env.PROTECTED,process.env.POINT+'.sqlite'),operations:process.env.OPERATIONS,publication:process.env.PUBLICATION},destination:p.join(process.env.PROTECTED,process.env.POINT+'-private'),recoveryPointId:process.env.POINT,quiescenceEvidenceRef:process.env.COLD_REF,confidentialityEvidenceRef:process.env.CONFIDENTIAL_REF,requiredRetainedOperationIds:ids};
fs.writeFileSync(p.join(process.env.PROTECTED,process.env.POINT+'.request.json'),JSON.stringify(r),{flag:'wx',mode:0o600});
NODE
node dist/scripts/privatePhotoColdBackup.js snapshot "$SOURCE_DB" "$PROTECTED/$POINT.sqlite" > "$EVIDENCE/$POINT.snapshot.json"
node dist/scripts/privatePhotoColdBackup.js capture "$PROTECTED/$POINT.request.json" > "$EVIDENCE/$POINT.capture.json"
DIGEST=$(node -e 'const r=require(process.argv[1]);if(!/^[a-f0-9]{64}$/.test(r.manifestSha256))process.exit(1);process.stdout.write(r.manifestSha256)' "$EVIDENCE/$POINT.capture.json")
set -o noclobber
printf '%s\n' "$DIGEST" > "$EVIDENCE/$POINT.manifest.sha256"
node dist/scripts/privatePhotoColdBackup.js verify "$PROTECTED/$POINT-private" "$DIGEST" > "$EVIDENCE/$POINT.verify.json"
```

Use an unused POINT and check evidence output names are absent BEFORE running;
shell redirects create confidential result files, not proof of quiescence.
Preserve outputs on any failure; never overwrite a partial bundle. The SQLite
backup API includes committed WAL; only the new copy becomes DELETE-mode,
sidecar-free. Keep all original roots cold through snapshot/capture/verify.
Retain the digest in the separately protected owner record, not solely inside
the bundle. Do not publish the full DB, operator request or source inventories.
Verification reopens copied DB/artifacts without starting the application.
Any authorized confidential transfer must retain that external digest and
repeat only the same nondestructive verifier at the destination as necessary
to validate transfer; no runnable restore or synthetic CI rerun is requested.

Scope is full sensitive authority DB plus retained private main/thumb and
publication anchors. Canonical bytes require the separate existing backup;
raw originals remain OFF. Historical missing files, AI staging and excluded
worker/orphan paths are not recovered. Unknown files INSIDE selected roots fail
closed. Restored physical/executor identities, leases, fences and tokens remain
historical evidence: never start a runtime against this restored DB or reuse
them to authorize publication. Runnable disaster recovery is outside this contract.

## Rollback assessment

Read-only inspection of `43b9bc3` shows `photoPublicationExecutor.ts`'s
`cleanupCommittedPublication` recursively removes the operation publication
namespace and unlinks the generation's sealed main/thumb after identity checks.
`aiIntakePhotoFinalization.ts` also directly unlinks private files after a created
commit, before calling that helper. W2 uses the helper after commit. Thus an old
runtime accepting new/recovered in-flight work can resume removal of newly
retained evidence. A terminal committed retry normally returns without this
path; rollback is not an immediate blanket purge, but is **not harmless**.
There is no approved old-runtime cleanup-off switch.

If rollback is necessary, first inhibit mutations/recovery/cron and preserve a
verified cold point. Do not resume old W2/W4 writers under the approved policy.
Any rollback build preserving retention needs its own reviewed candidate and
affected evidence; none is invented or developed here. No schema downgrade,
authority rewrite or restored-token replay is authorized. Previously deleted
bytes are not recreated by code rollback.

## Single remaining owner package

Supply Claude/Copilot results; authorize target metadata collection; return
aggregate Render capacity/workload and existing destination-protection facts;
approve the quantified retention horizon/reserve and actual cold/restart/cron
procedure. Only then authorize the exact-commit deployment and the minimum
target retention/capture acceptance above. If existing host quiescence or
confidential storage is unavailable, report that concrete blocker before
activation. No live operation, CI rerun, push, merge or permission change was
performed while preparing this package.
