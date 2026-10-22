# Gate 5 limited retention / cold-evidence — production acceptance record

Recorded 22 October 2026. Target: production API `srv-db34390m7kps73cv8l6g` (`noctella-production-api`), instance `srv-db34390m7kps73cv8l6g-76f54c476b-t26vb`, runtime **486639e755dca2e1c29c6530e6133f3a07094b89** (PR #496, branch `feat/gate5-private-operation-backup-20261021`). All times UTC unless marked.

This record supersedes the "production acceptance PENDING" statements in `GATE5_PRODUCTION_RELEASE_PACKAGE.md` for the scope below only. It is not a merge authorization, a normal-use resumption, a scheduler restoration or a disaster-recovery claim.

## Result

**Gate 5 limited production acceptance: PASS** — initial empty-scope cold point, one designated production W2 photo, one idempotent replay, and a second cold point requiring that W2 operation all passed on the original persistent disk.

| Item | Result |
|---|---|
| Point 1 (`prod-p1-20261022`, empty required scope) | PASS — `integrity: ok`, 1 file, `runnableRecovery: false` |
| Production W2 (one synthetic photo) | PASS — committed, private + anchors retained with real `pfs1` identities |
| Idempotent replay (same `Idempotency-Key`) | PASS — same photo, same operation, unchanged retention digest |
| Point 2 (`prod-p2-20261022`, W2 operation required) | PASS — `integrity: ok`, 5 files, `runnableRecovery: false` |
| Local point-sets used | 2 of 2 (a failed first capture attempt is counted inside set 1, see below) |
| Production photos admitted today | 1 of 5 (manual tally) |

## Evidence classes

1. Owner-run Render Shell output on the production instance (this session).
2. Render connector read-only service inventory and application logs (this session).
3. GitHub source at exact runtime `486639e` (CLI and capture rules read directly).
4. Historical results carried over from earlier records (CI run 39659880724, RC2 W4, maintenance backups). Not re-run.

## Preconditions (already satisfied before this session's work)

- Exact runtime deployed LIVE on the same service and disk; old instance `tmkj8` SIGTERM/shutdown at 2026-10-21T21:14:20.9Z, new instance `t26vb` started 21:15:47.7Z (~86.8 s gap; no overlap).
- Maintenance-point backups (old runtime): DB key `database-backups/noctella-sqlite-20261021T210716032Z-9ca9a1cf9e954eac.sqlite` (sha256 `9ca9a1cf9e954eacc8735b860e5c52e998c65a273ef8ba1fe1cc47aaddcb23df`, `db:restore-verify` ok); photo manifest `product-photo-backups/manifests/20261021T210718379Z-d42b4ad5…8843.json` (`photos:recovery-verify` 302 artifacts ok).
- Release preflight 2026-10-22T07:38:51.928Z: **WARN, no FAIL** (899 MiB free < 1024 MiB warning threshold; threshold unchanged; 0042 reserved/unregistered). Intents `[]`; operations attention/rollback blockers `[]`.

## Cold interval evidence

- Render connector (08:32Z): API `maintenanceMode.enabled=true`, `autoDeploy=no`, not suspended; crons `background-jobs` (`crn-db3447om7kps73cvc8dg`), `database-backup` (`crn-db3447om7kps73cvc8d0`), `product-photo-backup` (`crn-db3447om7kps73cvc8e0`) all `suspended` by user.
- Application logs since instance start (21:15Z) to 08:30Z: no POST/PUT/PATCH/DELETE; no `/api`, admin, photo, backup, outbox or job lines; only `GET /health`.
- Per capture gate (Shell): API PID 52 had no child processes; other interactive shells (idle orphans 929, 835, 788) had no children; zero ESTABLISHED connections on :10000; API uptime monotonic (no restart) throughout.
- `production-admin` service is not in maintenance, but logs show no admin-originated API mutation.
- Source DB: explicit realpath equal to the live `DATABASE_URL` file under `/var/data`, regular file, WAL present, same device as canonical root. Path not recorded here.

## Point 1 — `prod-p1-20261022`

- Snapshot: sha256 `e622b01dabcbe59c714894e3cce87e0d535b86c3ae27781f36a0432ed7e9a213`, 2,965,504 B, DELETE journal mode, no sidecars.
- Source scope at snapshot: operations root contained only directories `38829870-5b8a-47f5-bdae-540d174e2ccc/1` (pre-retention committed `product_upload`, files already removed by old T2 cleanup); publication root empty; 0 files. `requiredRetainedOperationIds=[]` justified by that inventory.
- **Attempt 1 (08:20Z) rejected at request validation**: quiescence/confidentiality reference IDs contained `:` and `.` (CLI requires `^[A-Za-z0-9_-]{1,128}$`). Bundle destination was never created; empty `prod-p1-20261022.capture.json` retained as evidence. Owner decision (11:23 Europe/Istanbul): keep the same point-set and retry with a corrected request (`request-r2.json`) against the unchanged snapshot (hash re-verified) and unchanged source tree.
- Attempt r2: capture `files:1`, scope `owner-operated-cold-evidence-only`, `runnableRecovery:false`.
- **External manifest digest: `e118aea74466950553a574cf0c1b9d6cc6144f688a9f58e54a89282126cc20df`**; verify `integrity: ok`, `files:1`, `runnableRecovery:false`. Bundle 2,994,176 B.

## Production W2 — one designated photo

- Target product (owner-approved): `dc15b7ab-9ca6-4e84-8db8-8ea7a822af3d`, SKU NOC-000001, "Staged intake with 1 photo" (existing test record; `published`; owner notes the system is not in use).
- Input: synthetic 1600×1200 JPEG generated on the instance, 632,938 B, sha256 `755cf138aacf04f058f1cf769f844ecf91d3a565d56b9c68a758294dd4ffa20d`.
- Route: existing `POST /api/products/:id/photos` over loopback with an owner admin session (owner entered credentials via hidden prompt; nothing printed or stored), fixed `Idempotency-Key` (32 chars). Fencing ON → `uploadFencedProductPhoto`.
- First upload attempt returned 401 (no mutation, no operation, no staging): the session cookie is `Secure; Domain=.noctella.com`, so curl did not attach it to `http://127.0.0.1`. Correct behaviour; second attempt sent the cookie explicitly.
- Upload 08:59:02Z: **HTTP 201**, photo `05f17357-648b-47cb-b254-c7be7eee5c49`; exactly one new operation `f5f7c10c-ab9d-40c6-bf9c-f397e6e264d8` (`product_upload`, `committed`, generation 1, seal `f119502e-18bf-4ba6-b0ab-6595f3c09265`); product photos 5 → 6.

| File | Exists | sha vs record | inode | nlink | bytes | identity |
|---|---|---|---|---|---|---|
| private main | yes | match | 381 (= seal) | 1 | 726,954 | pfs1 |
| private thumb | yes | match | 382 (= seal) | 1 | 3,540 | pfs1 |
| anchor main | yes | match | 384 (= copy record) | 2 | 726,954 | pfs1 |
| anchor thumb | yes | match | 386 (= copy record) | 2 | 3,540 | pfs1 |
| canonical main | yes | — | 384 (= anchor) | 2 | 726,954 | — |
| canonical thumb | yes | — | 386 (= anchor) | 2 | 3,540 | — |

Retention digest (verifier over the table above): `c5ee46534c0ad3fbb63d80fdb9746d58fdf8aa2436c3334c9dd38db5b35f0f35`. Worker children exited (API child count 0).

- **Replay** 09:01:16Z, same file and key: HTTP 201, same photo, same single operation, product photos still 6, retention digest unchanged. Logout 09:01:17Z (200). W2 allowance closed at 09:01:17Z.
- Connector logs 08:30Z–09:01Z: only these requests (login ×2, upload 401, upload 201, replay 201, logout).
- Side effect: one outbox event `product_photo.promote_requested` **Pending**, left untouched (background-jobs cron suspended; no dispatch/retry).

## Point 2 — `prod-p2-20261022`

- Cold record 09:02:59Z: API children 0, other-shell children 0, :10000 connections 0, free 934,928,384 B; source tree inventory recorded in `prod-p2-20261022.cold.txt`.
- `requiredRetainedOperationIds=["f5f7c10c-ab9d-40c6-bf9c-f397e6e264d8"]`.
- Snapshot: sha256 `e588cb0f56ffa44a088f001bc275796783f88f3a5b5f529797a7298d2c2b73a9`, 2,965,504 B, DELETE, no sidecars.
- Capture: `files:5` (DB + private main/thumb + two anchors), `owner-operated-cold-evidence-only`, `runnableRecovery:false`.
- **External manifest digest: `2fbfc1295d63666b691f9d3a6de8d1711a80e8591f73406fd11581e2090ee60f`**; verify `integrity: ok`, `files:5`, `runnableRecovery:false`. Bundle 4,481,024 B.

Both digests are also kept outside the bundles in the evidence directory and in the owner's private record.

## Measured capacity (actual, not a benchmark)

| Point | Free on `/var/data` (B) |
|---|---|
| Before Point 1 | 942,718,976 (≈899.0 MiB) |
| After Point 1 | 936,726,528 |
| Point 2 cold record (after W2) | 934,928,384 |
| After Point 2 | 927,457,280 (≈884.5 MiB) |

Total consumed ≈ 14.6 MiB (two snapshots, two bundles, W2 private + canonical/anchor pairs, WAL growth). Headroom above the approved 512 MiB floor ≈ 372 MiB. Measured W2 pair: 730,494 B (synthetic noise image compresses poorly, so this is conservative vs. the 440 KiB illustration); source growth ≈ 1.4 MiB/photo (private pair + canonical/anchor pair). The 1024 MiB preflight WARN is unchanged and still applies.

## Evidence locations (owner-private, same disk; not disaster recovery)

`/var/data/gate5-private-evidence-20261021/points` and `/evidence` (mode 2700, owner UID 1000):
`prod-p1-20261022.{sqlite,request.json,request-r2.json}`, `prod-p1-20261022-private/`, `prod-p1-20261022.{cold.txt,cold-r2.txt,snapshot.json,capture.json(empty, attempt 1),capture-r2.json,manifest.sha256,verify.json}`, and `prod-p2-20261022.{sqlite,request.json}`, `prod-p2-20261022-private/`, `prod-p2-20261022.{cold.txt,snapshot.json,capture.json,manifest.sha256,verify.json}`. W2 working files (synthetic image, verifier output, login headers) are in ephemeral `/tmp/gate5-w2-20261022` only. Nothing was deleted or overwritten.

## Not claimed / still open

- No runnable recovery, off-disk protection, encryption or disaster recovery for the private bundles (Destination A, same disk).
- PostgreSQL acceptance not claimed (CI: 43 PostgreSQL-related skips).
- RC2 whole-root capture remains BLOCKED by historical records (a272b007…, 322cf602…, 39271b8a…); the RC2 W4 retention/replay PASS is reused, not re-run.
- W4 ICC/colour visual acceptance OPEN. W11/0042 blocked; 4B parked. Photo Stage 5 not closed.
- Overall programme remains **5/12**; the original numbered stage mapping is unavailable, so no advance is recorded here.
- Open operational items: 1 Pending `promote_requested` outbox event (processed only when schedulers resume); 5 historical `product_photo.delete_requested` DeadLetter events not yet reviewed; one unused admin session from the first login expires ≈20:56Z.
- CI artifact 12372843041 expires 2026-11-04T19:16:25Z; this record and `GATE5_EXACT_HEAD_CI_39659880724.md` hold the durable summary.

## State left in place

Maintenance Mode ON; three production crons suspended; autoDeploy off; no scheduler restoration, normal-use resumption, merge, deploy, purge or paid change. Each requires a separate owner decision.

## Operator-procedure notes for future points

- Reference IDs in the capture request must match `^[A-Za-z0-9_-]{1,128}$`.
- On Render the API launcher (PID 1) is also `bash` with PPID 0; exclude it when counting children of other interactive shells.
- Render Shell truncates long pastes; keep each block short (≲3 KB) and split into guarded parts.
- Loopback admin calls need the session cookie sent explicitly (`Secure`, `Domain=.noctella.com`).
- Gate 5 approved scope (two point-sets) is now fully used; any further point requires a new owner decision.
