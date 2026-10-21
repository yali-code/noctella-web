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
proved. Final reviews: **Claude PASS; Copilot PASS**, as supplied by the owner
in this consolidation request for runtime candidate
`486639e755dca2e1c29c6530e6133f3a07094b89` / PR #496. Attribution is the
owner's report of each review, not a newly fetched review or a claim that either
review covers later documentation. Review URLs/raw reports and their embedded
SHA attestations were not supplied; no review identifier is invented.
Production acceptance remains **PENDING**.

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

### Owner-supplied measured baseline and initial manual limit

Owner reports current runtime `43b9bc3` (full recorded SHA
`43b9bc3af4be8ed89be35c95d59c26435485573e`) on
`srv-db34390m7kps73cv8l6g`. These are owner-provided measurements, not a live
scan by this agent; measurement timestamp was not supplied.

| Measurement | MiB | Files |
| --- | ---: | ---: |
| Filesystem total | 973.41796875 | — |
| Available | 898.375 | — |
| Canonical allocation | 50.0703125 | 316 |
| Private allocation (directories only) | 0.01171875 | 0 |
| Publication allocation (directory only) | 0.00390625 | 0 |
| Unique union allocation | 50.0859375 | — |

External hardlinks: zero. Total minus available is 75.04296875 MiB;
subtracting this photo union leaves 24.95703125 MiB of other allocation and/or
filesystem reservation, NOT an identified DB size. Historical private/anchor
bytes are absent; do not recreate them or claim their backup coverage.

The owner selected **5 photos/day MANUAL**, replacing 30. It is not a quota,
rate limiter or guarantee; count photos, including each photo in multi-photo
W4 intake, rather than HTTP requests. Every additional committed generation,
failure/partial and retry-created artifact also consumes capacity. Operator
must stop further admission at the manual limit and keep a private tally.

`P=440 KiB` per main/thumb pair remains illustrative, not measured. For five
new photos/day, assuming one generation each and canonical photos remain:

| Increment | Per day | 30 days |
| --- | ---: | ---: |
| New canonical/publisher pair bytes (anchors share these inodes) | 2.1484375 MiB | 64.453125 MiB |
| New separate private pair bytes | 2.1484375 MiB | 64.453125 MiB |
| Total source image growth | 4.296875 MiB | 128.90625 MiB |

Do NOT add a third `P` for anchors while canonical names exist. After canonical
deletion anchors retain the publisher `P`, so source image growth stays `2P`:
canonical deletion does not recover those retained bytes. Allocation rounding,
directories/ledgers, temporary raw/staged/encoded files, superseded/partial
generations, DB/WAL and non-photo workload are additional unknowns. Raw-original
retention OFF does not mean zero temporary original bytes.

A full limited private bundle at day30 adds roughly another 128.90625 MiB of
image payload plus full DB/manifest. Snapshot adds another full DB; canonical
backup/download verification and failed partial output need separate peak
headroom. Keeping every daily full bundle for 30 days would add about
1998.046875 MiB of image payload alone (sum of days1..30), exceeding currently
available space: **not a feasible on-disk cadence**. No such cadence is approved.
An off-disk transfer changes local occupancy only after verified transfer and
separately authorized removal; no purge/removal is authorized by this package.

Thirty-day image-only source projection leaves 769.46875 MiB of current free
space, or 640.5625 MiB with one additional day30 full private image bundle,
BEFORE all unmeasured costs. These are conditional arithmetic, not an approved
reserve, release authorization or indefinite capacity claim. No paid expansion
is authorized. Owner must choose a finite review horizon, backup cadence/count,
maximum temporary/partial budget and reserve after actual DB/working-set sizes.
**Capacity baseline is known; operational headroom decision remains PENDING.**
The existing preflight will WARN below 1024 MiB (this filesystem's TOTAL is
already below that threshold). Do not weaken it or report all-green preflight;
the owner must explicitly evaluate/accept that WARN with measured headroom.
Existing capture limits (128 MiB DB, 16 MiB/file, 512 MiB payload, 4096 files,
10000 rows/authority table, 2 MiB manifest) must also fit actual inventory;
free disk does not waive them. No activation recommendation before this review.

## Target preflight (future authorization required)

After the exact-commit deployment described below, from built `apps/api`:

```bash
test "$RENDER_SERVICE_ID" = srv-db34390m7kps73cv8l6g &&
test "$RENDER_GIT_COMMIT" = 486639e755dca2e1c29c6530e6133f3a07094b89 &&
test "${DATABASE_DRIVER:-sqlite}" = sqlite &&
test "$PHOTO_OWNERSHIP_FENCING_ENABLED" = true &&
test "$PHOTO_PREPARATION_CONFINEMENT" = required &&
test -x "$PHOTO_PREPARATION_LAUNCHER" &&
npm run photos:release-preflight
```

Record every PASS/WARN/MANUAL/FAIL. In particular the 898.375 MiB baseline
implies the unchanged 1024 MiB warning; do not waive it implicitly. Fencing,
confinement, helper provenance and real persistent identity must pass. Minimum
retention acceptance and the concrete deployment order are specified below.

## Executable confidential-destination procedure

Run only inside the authorized cold interval on the original-filesystem Linux
host, using the reviewed built API. The owner must select an **existing**
protected writable destination and separately retained evidence/digest location;
neither is approved by this document. Verify actual at-rest protection,
authorized readers, mount/backing-store provenance and confidential transport
before any remote copy. Mode bits alone do not prove encryption. If these
facts cannot be established, STOP; do not use public temp/artifacts or assume
an S3 adapter supplies confidentiality. No new encryption platform is required.
The bootstrap sequence below supersedes any assumption that the new CLI already
exists in the old production build. Do not copy private roots to another host.
Existing canonical `photos:backup`, DB
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
const ids=JSON.parse(process.env.REQUIRED_IDS_JSON);if(!Array.isArray(ids))throw Error('Reconciled IDs required');
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
An empty required-ID array is valid only for the owner-reconciled initial point
with no retained policy-scope operations, as in the supplied zero-file baseline.
The later acceptance point must require the new W2/W4 operation IDs.
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

## Existing destination: reusable facts versus missing facts

Repository structure establishes two API-only S3-compatible adapters/config
families, `DATABASE_BACKUP_S3_*` and `PRODUCT_PHOTO_BACKUP_S3_*`, with separate
DB/photo prefixes. Credentials stay on the API; cron jobs only send
authenticated HTTP requests. Adapters stream bounded artifacts, write hash/size
metadata, download and verify content; DB verification checks integrity.
The accepted 4C record documents successful uploads and DB restore verification
at the old point. This establishes historical functionality, not current privacy.
Sources: `docs/deployment/database-backup-recovery.md`,
`docs/deployment/product-photo-backup-recovery.md`, `render.yaml`,
`apps/api/src/repositories/{database-backup,product-photo-backup}/s3Compatible.ts`.

The adapters do NOT set object ACLs, request explicit SSE/KMS encryption, inspect
bucket policy/public access or establish lifecycle/versioning/authorized readers.
Endpoint HTTPS is not enforced by config parsing. The DB guide delegates
retention to external lifecycle; the photo guide warns against age-only expiry
of shared content-addressed objects. Neither approves expiry of this new scope.
Actual endpoint TLS, public-access policy, at-rest encryption, readers/key
scope, provider lifecycle and permission to store full DB/private evidence are
missing owner-held facts. Existing successful hashes do not establish them.

Reuse of the existing DB destination is a reasonable proposal ONLY if its
existing protection covers the sensitive full authority DB and retained bundle,
owner approves an isolated unused object prefix, and a compatible existing
operator transfer tool is available. The photo destination is not presumed
approved for full DB data. No secret, bucket value or new destination is
recorded here. The current CLI produces a private local DIRECTORY, not an S3
object and not an automatic uploader. Existing canonical/DB backup commands do
not upload these retained roots. A provider-console confirmation plus an already
available confidential transfer workflow is required; absent that, off-disk
private-bundle protection stays BLOCKED, not silently satisfied by DB backup.

## Concrete bootstrap and maintenance sequence

Use Render's EXISTING paid-web-service **Settings → Maintenance Mode** toggle,
not an invented application endpoint: it blocks public requests while keeping
the instance and Shell/SSH available. It does NOT block private traffic.
Inventory the actual production cron/services first; the recorded hourly
`noctella-production-background-jobs` is known. `render.yaml`'s database backup
(03:00 UTC), photo backup (04:30), analytics snapshot (05:15) and hourly jobs
are STAGING definitions, not proof of production counterparts. Enumerate any
production equivalents and manual/private callers. Existing Render service
**Suspend/Resume** controls inhibit cron service scheduling; capture actual
status, prior settings and running-run termination/completion evidence.
If that control is unavailable for a listed service, STOP and obtain its actual
supported inhibition mechanism; don't substitute a schedule guess. Canceling
an HTTP caller does not cancel API work already dispatched.

1. Owner separately authorizes these lifecycle operations; record previous
   maintenance/cron/auto-deploy states and assigned operator. Enable Maintenance
   Mode on the API; confirm public 503 without credentialed mutation. Suspend
   all actual scheduled callers, prohibit Trigger Run/manual dispatch and all
   other private callers. No inbound-IP plan upgrade or permission change.
2. Drain ALL already-dispatched API mutations, DB backup snapshots, photo work,
   outbox/deletion/recovery and preparation descendants. Read operation/intent
   reports and due/Processing event counts. This code starts no scheduler loop
   in `index.ts`; startup DOES import DB/schema and seed categories, so startup
   completion must precede any cold point. Keep default health checks running;
   a healthy idle API is not itself evidence that no writer remains. Observe
   stable instance, no active mutator and blocked dispatch sources throughout.
   Any restart/redeploy/new request invalidates the interval: STOP capture and
   re-establish evidence, retaining partial output. No automatic restart lock
   is invented. If the operator cannot exclude private/unmanaged writers, STOP.
3. While old `43b9bc3` is still running but admission blocked, use its EXISTING
   DB/canonical backup and verification commands at this maintenance point
   (remote writes require the future explicit authorization). These HTTP-only
   calls must use the verified private API host/port while public maintenance
   remains ON; never disable maintenance just to reach them. Let them finish,
   then drain again. The zero-file private/publication inventory is reconciled
   and recorded; do not demand the unavailable new CLI for this pre-deploy point.
4. Manually **Deploy a specific commit** `486639e755dca2e1c29c6530e6133f3a07094b89`
   on the SAME service, with maintenance and cron inhibition still in effect.
   Render builds API/helper away from the disk, stops the old disk-backed
   instance and starts the new build with that SAME original persistent disk.
   Verify exact SHA, old-stop-before-new-start logs, startup finished and new
   Shell session. Inspect retained physical identity normally; a new instance
   does not authorize rewriting it. No pre-deploy hook, one-off job, second
   service, local tsx install or copied-inode workaround can access/prove this
   source. Specific-commit deployment disables auto-deploy per Render docs;
   record this effect, do not silently restore moving-branch deployment.
5. Before admitting ANY new photo, verify built CLI/helper presence and preflight,
   then establish a fresh genuinely quiesced interval after startup. Capture
   and independently verify the initial new-CLI point on the original mount,
   reconciling empty required IDs only if the actual scope remains empty.
   This is a LIMITED CODE DEPLOY under blocked admission, not operational
   retention acceptance. No circular requirement for a pre-deploy new CLI.
6. Once capacity/destination and this point pass, separately authorize only one
   designated W2 test photo and one W4 test photo (two of that day's five).
   Keep public maintenance ON; the named operator alone uses existing private
   API paths with existing authorization. No full F2/4C replay or deletion test.
   Verify committed retention and retry behavior, then stop that allowance,
   drain again and capture/verify requiring both new operation IDs. Record
   actual allocation/DB/temp peaks and revised headroom, not illustrative sizes.
7. Restore ONLY owner-approved prior cron states in a controlled order after
   all backup/verification handles exit; check no deferred overlapping run was
   launched. Leave unrelated pre-existing suspensions intact. Maintenance Mode
   and normal-use admission remain ON/paused unless separately authorized;
   do not turn normal use on as part of this Gate 5 package. If scheduler
   restoration can mutate the source, it ends the cold interval explicitly.

Existing operator commands, from `apps/api`, ONLY during the separately
authorized sequence (these backup commands perform remote writes and are NOT
part of the read-only collection below). The existing private `API_HOSTPORT`
and scheduler authentication must already be available to the command; do not
echo or replace credentials. Use the actual newly recorded DB object key and
photo manifest key, not an earlier maintenance point:

```bash
npm run db:backup
npm run photos:backup
npm run db:restore-verify -- "$DB_BACKUP_KEY"
npm run photos:recovery-verify -- "$PHOTO_MANIFEST_KEY"
```

Each must succeed before moving on; retain the underlying safe key/hash records
privately. Following a stop/failure, the existing fenced reports are:

```bash
npm run photos:operations-report
npm run photos:publication-intents
```

These reports import the normal runtime DB bootstrap; use only on the verified
current schema under the maintenance authorization, not as an unqualified
side-effect-free way to inspect an arbitrary restored database. No `--attest-exit`
is included: recovery attestation requires the exact real intent and separate
termination evidence per `docs/engineering/PHOTO_OPERATION_FENCING_RUNBOOK.md`.

Platform sources checked read-only 21 October 2026:
[maintenance](https://render.com/docs/maintenance-mode),
[disks](https://render.com/docs/disks), [SSH](https://render.com/docs/ssh),
[deploys](https://render.com/docs/deploys),
[health checks](https://render.com/docs/health-checks).
[Suspend API](https://api-docs.render.com/reference/suspend-service-1) and
[Dashboard Suspend/Resume](https://render.com/changelog/suspend-and-resume-services-in-bulk-from-the-render-dashboard)
document the service controls; verify actual cron status rather than inferring
successful inhibition from a click or accepted API request.
Maintenance blocks public traffic only; disk access is runtime-only and not
available in build/pre-deploy/one-off jobs. Killing/freezing the API is not a
maintenance mechanism: failed health checks can cause automatic restart.

## Exact read-only fact collection still needed (owner runs; not run here)

Do not repeat the supplied complete allocation scan unless stale/changed.
In the verified API Shell, these commands print only safe target/config facts
and allocation totals, not values of endpoints, credentials or DB records:

```bash
node <<'NODE'
const fs=require('node:fs'),p=require('node:path');
console.log({targetMatches:process.env.RENDER_SERVICE_ID==='srv-db34390m7kps73cv8l6g',runtime:process.env.RENDER_GIT_COMMIT,driver:process.env.DATABASE_DRIVER||'sqlite'});
for(const prefix of ['DATABASE_BACKUP_S3_','PRODUCT_PHOTO_BACKUP_S3_']){
 const present={};for(const k of ['REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'])present[k]=Boolean(process.env[prefix+k]?.trim());
 let tls='standard-endpoint-if-config-valid';if(process.env[prefix+'ENDPOINT']){try{tls=new URL(process.env[prefix+'ENDPOINT']).protocol==='https:'?'https':'NOT-HTTPS';}catch{tls='INVALID';}}
 console.log({family:prefix,present,transport:tls});
}
if((process.env.DATABASE_DRIVER||'sqlite')!=='sqlite')throw Error('Wrong database driver');
const db=process.env.DATABASE_URL;if(!db||!p.isAbsolute(db))throw Error('Verified absolute SQLite source required');
for(const suffix of ['','-wal','-shm','-journal']){try{const s=fs.lstatSync(db+suffix,{bigint:true});console.log({databasePart:suffix||'main',logicalBytes:String(s.size),allocatedBytes:String(s.blocks*512n)});}catch(e){if(e.code!=='ENOENT')throw e;console.log({databasePart:suffix||'main',absent:true});}}
for(const root of [process.env.PROTECTED,process.env.EVIDENCE].filter(Boolean)){const s=fs.lstatSync(root);const v=fs.statfsSync(root,{bigint:true});console.log({selectedParentPrivate:s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0,availableBytes:String(v.bavail*v.bsize)});}
const temp=process.env.TMPDIR||require('node:os').tmpdir();const tv=fs.statfsSync(temp,{bigint:true});console.log({temporaryFilesystemAvailableBytes:String(tv.bavail*tv.bsize)});
console.log({builtColdCliPresent:fs.existsSync('dist/scripts/privatePhotoColdBackup.js')});
NODE
ps -eo pid,ppid,comm
for tool in aws rclone tar; do command -v "$tool" || true; done
```

If PROTECTED/EVIDENCE are unset, their protection remains unknown; these optional
inputs name existing owner-selected paths, not new approved directories. In
Dashboard read-only inspection record Maintenance Mode availability/state,
current build/start/health settings, auto-deploy, disk mount, all private callers,
cron actual names/schedules/statuses and active runs. In the EXISTING storage
provider console record public-access policy, at-rest encryption/protection,
authorized readers/key scope, TLS endpoint, lifecycle/versioning and whether
the approved retention scope would expire. Config-presence output is not proof
of those properties; provider facts cannot be derived from repository config.
Inspect available transfer-tool help/version without installing anything;
no full DB/artifacts may be sent until destination and transfer are approved.
Process names/PIDs are an inventory, not proof that an HTTP mutation is idle.
Parent-path checks must also exclude symlink ancestors and reconcile actual
mount protection; do not treat these shallow checks as the CLI's full verifier.
Use the standalone-copy aggregate queries above for workload once that copy
exists; don't create a snapshot merely to collect live-read metadata now.

## Executable stop/recovery plan and minimum release authorization

On any failed prerequisite/capture/preflight/target retention check: keep API
Maintenance Mode enabled; keep scheduled/private dispatch inhibited, withdraw
the named test allowance, drain work and preserve logs, partial bundle and
external digest. Do not delete evidence, retry a denied action or clear DB rows.
Use existing `photos:operations-report` and `photos:publication-intents`
read-only reports under the reviewed code. Resolve any authorized intent only
through the existing fenced runbook with genuine executor-termination evidence;
no blanket attestation, lease/token reuse or restored DB startup. Prefer keeping
the reviewed code deployed idle. If a code rollback is necessary, old
`43b9bc3` must remain mutation-inhibited: it is not a retention-safe resumed
runtime. Dashboard **Suspend Service** is an emergency full stop when admission
cannot be controlled; it sacrifices shell access and is NOT the backup path.
Resume only into an explicitly reviewed safe candidate/maintenance procedure,
not a promised zero-risk rollback. Runnable restore remains outside scope.

Single next authorization request: approve a finite capacity horizon/reserve
and backup count after the safe fact collection; confirm existing confidential
destination/transfer; authorize API Maintenance Mode plus actual cron
Suspend/Resume/private-caller inhibition, current-point DB/canonical backups,
exact-commit deployment under blocked admission, new-CLI initial capture,
two designated W2/W4 test photos/retry verification and subsequent required-ID
capture/verify, with only the specified scheduler restoration. No merge/push,
normal-use resumption or paid change is implied. If destination/host controls
remain unverified, code release and operational acceptance remain pending.
**Entire Photo Stage 5 is not closed; overall remains 5/12.**
