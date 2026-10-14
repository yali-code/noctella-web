# Photo storage safety: release readiness (#390, #396, #403, #407)

**Verdict: PARTIALLY READY (development and CI evidence only). NOT production-ready.**

- **Branch:** `feat/photo-storage-final-readiness`, stacked on #412 (`feat/photo-legacy-writer-gates-p2-2b3d6`) at exactly `44e0df2726f02aabdb7ed7e8230c47d0a6e23036`.
- **Not done:** no merge, deployment, staging or production migration, writer activation, instance shutdown, media deletion or provider call.
- `PRODUCT_PHOTO_DISK_STAGING_ENABLED` stays OFF by default.

Evidence levels used below:

| Level | Meaning |
| --- | --- |
| **DEV** | Local Windows disposable harness |
| **CI** | GitHub Linux with a real PostgreSQL 16 service |
| **STAGING** | Not performed |
| **PROD** | Not performed |

## 1. Changes and commits

| PR / commit | Delivered |
| --- | --- |
| #406 `ac4a4ff` | Generation-private sealed storage capability (development) |
| #408 `a5b8236` | Disk budget, measured 42 vs 74 MiB, ext4 ENOSPC (CI) |
| #409 `b61f7e8` | Read-only DB/outbox recovery classification |
| #410 `6c4c2b8` | 14-writer adoption matrix and census guard |
| #411 `8a03093` | Proposed ownership schema and finalize contract (SQLite and PostgreSQL CI) |
| #412 `44e0df2` | Development legacy-writer shutdown gate and migration checklist |
| this branch `cc0172e` | Packages B/C: authority adapter so the real capability runs on the proposed tables; end-to-end fenced AI finalization harness; recovery reads `photo_operations` |
| this branch (docs commit) | This readiness document (Packages A/C/D/E) and evidence |

## 2. Final 14-writer protection matrix

| # | Writer / deleter | Protection status | Evidence |
| --- | --- | --- | --- |
| 1 | Legacy upload | **UNPROTECTED**; gate contract DEV only | #412 gate tests |
| 2 | Staged upload | **UNPROTECTED** (in-process 42-MiB reservation only). BLOCKED: no request-stable operation id or client idempotency key; the capability is Buffer-fed (84 MiB) instead of path-fed | #408, #410 |
| 3 | AI intake upload | **UNPROTECTED**; needs an intake-root capability variant | #410 |
| 4 | AI deterministic finalization | **PROTECTED in the DEV harness only** (fencing, seal, no-overwrite publish, atomic finalize, idempotency, crash/reclaim, legacy conflict to review, budget); not wired | this branch DEV, CI pending |
| 5 | AI intake delete | **UNPROTECTED**; deletion not authorized | #410 |
| 6 | AI cleanup (deletes canonical) | **UNPROTECTED**; gate contract DEV only | #412 |
| 7 | Outbox promotion | **UNPROTECTED** (safe in same-root production mode; distinct-root mode must be forbidden) | #410 |
| 8 | Outbox canonical delete | **UNPROTECTED**; parking contract DEV only | #412 |
| 9 | Outbox temp cleanup (temp root = canonical) | **UNPROTECTED**; parking contract DEV only | #412 |
| 10 | Upload rollback deletion | **UNPROTECTED**; retain-on-ambiguity contract DEV only | #412 |
| 11 | Instagram derivatives and temp files in canonical root | **UNPROTECTED** | #410 |
| 12 | Reel rendering (`rename` overwrite) | **UNPROTECTED** | #410 |
| 13 | Photo backup temp files | Not a media mutator (budget accounting only) | #410 |
| 14 | DB backup / restore | DB-owned; free-space floor only | #410 |

**No writer is protected in the running application.**

## 3. SQLite and PostgreSQL validation

| Area | DEV (SQLite) | CI (PostgreSQL) |
| --- | --- | --- |
| Ownership schema and finalize contract (16 tests) | PASS | PASS (#411 run 38618252790) |
| Legacy gate drain parity (12) | PASS (11 + 1 skipped) | PASS (#412 CI, as reported in the mission brief; not re-observed here) |
| Fenced AI finalization end to end (8) | PASS (4 + 4 skipped) | **Pending**: runs when this branch's PR is opened |
| Recovery classification (19) | PASS (10 + 9 skipped) | PASS (#409) |
| Storage capability (48), fencing (35), crash (37) | PASS (with documented skips) | PASS (inherited CI) |

The exact local counts for this branch are in `photo-final-readiness-evidence/README.md`.

## 4. Memory and disk

**Disk** (#408, measured):
- **In-flight reservations:** B1 42.012 MiB (the 42-MiB constant under-counts); capability 74.04 MiB path-fed, 84.05 MiB Buffer-fed, 64.04 MiB deterministic.
- **Retained growth:** the capability keeps 10.7–17.2 MiB of private bytes per near-limit success, and the AI-finalization harness shows the retained footprint refusing the next attempt as a whole.
- **Real ENOSPC:** CI on a 64-MiB ext4 loop mount.

**Memory, #390: FAIL / BLOCKED.**
- The codec line #392/#394/#397 (owned separately; not modified here) records all three 24-MP combined trials at 512 MiB, exit 137, with one OOM kill each and 4 of 8 operations done (#397 run 38537514014).
- Codec-only normal encode: 255.6 MiB.
- `low_memory`: 104.6 MiB, but it **changes output pixels** (PSNR 41.2 dB against the existing WebP) and needs an owner fidelity decision.
- This machine has no cgroup or Linux environment, so no new acceptance measurement was possible, and **#390 is not claimed**.
- The capability adds no codec memory (same recipe), but the Buffer-fed producers copy the input (≤ 10 MiB). The path-fed design removes that copy.

## 5. Migration deployment prerequisites (Package A)

**Numbering:**
- `origin/main` and this stack end at PostgreSQL `0038`.
- `feat/etsy-listing-form-parity-phase1` and `fix/etsy-postgres-test-migration-0039` both carry `0039_etsy_listing_form_parity.sql`.
- The ownership migration must take the next free number **after** whichever lands first (expected `0040`). It must never reuse `0039`.
- SQLite needs a matching additive `ensureSchema` block.
- **Neither is registered.** The proposed DDL stays in `docs/engineering/proposed-photo-ownership/`.

**Proven in disposable databases:**
- additive upgrade over existing photo/outbox rows (rows unchanged);
- transactional failure leaves no partial schema;
- idempotent re-apply;
- `down.sql` removes only the new tables;
- legacy application rows coexist (finalize moves to `review` instead of duplicating);
- old code ignores the new tables.

**Required before any staging migration (owner authorization):**
1. DB backup and photo backup manifest, plus restore verification (`db:backup`, `photos:backup`, `db:restore-verify`, `photos:recovery-verify`).
2. Migration number assigned after the Etsy migration's status is confirmed.
3. Run on staging first and verify table and column parity.

## 6. Old-instance drain and verification

The #412 gate is **cooperative**: an older binary never calls it. Detection therefore cannot rely on application code alone.

1. **Platform inventory.**
   - With a persistent disk attached, Render runs a single instance and stops the old one before starting the new one, so there are no overlapping deploys.
   - **This must be confirmed for the actual service:** check the service settings and the deploy event log for "instance stopped" before "instance started".
   - Background workers or cron services that write media must also be listed and stopped. In this codebase the outbox dispatch runs inside the API process; verify there are no other services with disk access.
2. **Application-level confirmation (new builds only; design, not yet implemented).** A gated build should record its build SHA with every gate epoch it writes, so the operator can compare it with the deployed SHA.
3. **Drain:**
   - set the gate `OPEN → DRAINING`;
   - wait for the drain report to show `inflight=0` and no non-terminal delete or cleanup events (operator disposition of parked events);
   - set `CLOSED`.
4. **Stop rule.** Any unknown instance, retained marker or unknown outbox state means the gate stays in `DRAINING`. Escalate to operator review.

## 7. Rollback and forward-recovery playbook

- **Code rollback:** redeploy the previous build. The additive tables stay in place (older code ignores them), and the gate epochs stay as evidence.
- **Gate rollback:** an explicit `CLOSED → OPEN` creates a new epoch. Nothing is deleted, and parked delete/cleanup events resume only after operator disposition.
- **Schema rollback:** `down.sql` **only** when no operation is `preparing`, `sealed` or `review`. Otherwise forward-fix. Ownership rows and artifacts are evidence and are never pruned automatically.
- **Media:** never deleted, renamed or quarantined by any rollback. Retained private generations stay until a future authorized cleanup (§8).

## 8. Operator review and the future cleanup authorization protocol (Package C)

**Review queue inputs** (read-only):
- #409 reports with any `AMBIGUOUS_*` or `OPERATION_MARKER_RETAINED` artifact;
- `missingReferenced`;
- operations in `review` (`PUBLICATION_CONFLICT`, `LEGACY_PHOTO_ROW_EXISTS`, `COMMITTED_PHOTO_MISSING`);
- parked delete/cleanup outbox events;
- crash-retained gate, budget and marker locks.

**Operator decision per item:**
- keep;
- re-run finalize;
- dispose of a parked event (cancel or allow it while OPEN);
- escalate.

Each decision is a durable record with the evidence hash. There is no bulk action.

**Future cleanup (NOT implemented, NOT authorized).** A deletion of a private, superseded-generation artifact would need all of the following, in one locked section:
1. Hold the operation's #406 marker.
2. Re-read the authority in the same transaction, `FOR UPDATE` on PostgreSQL: the generation is superseded, the operation is `committed` or still `preparing` with a newer generation, and the artifact is not the committed seal.
3. Re-run the full #409 reference snapshot. The candidate must be unreferenced **and** unchanged in dev, ino, size and mtime.
4. Check no external reference (backup manifests, published URLs) points at the artifact.
5. Record a durable intent before the delete, and the result after it.
6. Have an explicit operator approval scoped to the artifact IDs.

Canonical files are never eligible. Age, PID, TTL and lease expiry never contribute.

## 9. Unresolved risks

1. No live writer is protected. Every canonical deleter is still active in the deployed application.
2. Cooperative gates do not stop old binaries; this depends on the platform procedure (§6).
3. The ownership migration is unregistered, and its number depends on the Etsy migration.
4. Retain-only storage grows without bound until the cleanup protocol (§8) is authorized and built.
5. #390 memory is still failing at 24 MP.
6. External references (Instagram/marketplace URLs, backup manifests) cannot be proven absent.
7. PostgreSQL results for this branch's end-to-end harness await CI.
8. This machine has under 400 MiB of free disk, so local evidence is partial: the build and the Admin/Storefront suites were not run locally and rely on CI. The full API suite passed locally.

## 10. Production gates

| Gate | DEV | CI | STAGING | PROD |
| --- | --- | --- | --- | --- |
| Ownership schema and contract parity | PASS | PASS | NOT RUN | BLOCKED (authorization) |
| Migration prepared, numbered and unapplied | PASS (proposed) | PASS (disposable) | NOT RUN | BLOCKED (numbering + authorization) |
| Old-instance drain procedure | DESIGNED | n/a | NOT RUN | BLOCKED (platform verification) |
| Legacy writers 1/6/8/9/10 gated | PASS (contract) | PASS | NOT RUN | BLOCKED (not wired, not authorized) |
| AI finalization fenced (writer 4) | PASS (harness) | PENDING | NOT RUN | BLOCKED |
| Staged upload fenced (writer 2) | BLOCKED | BLOCKED | NOT RUN | BLOCKED |
| Writers 3, 7, 11, 12 adopted | BLOCKED | BLOCKED | NOT RUN | BLOCKED |
| Recovery classification | PASS | PASS | NOT RUN | BLOCKED (operator workflow) |
| Cleanup / retained-byte reclamation | BLOCKED (not authorized) | n/a | n/a | BLOCKED |
| Disk budget / ENOSPC | PASS | PASS (ext4) | NOT RUN | BLOCKED (sizing decision) |
| 24-MP memory (#390) | n/a (no cgroup) | **FAIL** (#397) | NOT RUN | BLOCKED |
| Default-OFF compatibility | PASS (census) | PASS | NOT RUN | PASS by construction (no wiring) |
| API / Admin / Storefront regressions, typecheck, build, lint | API vitest 6,106 passed / 0 failed / 34 skipped; typecheck and lint PASS; Admin, Storefront and build not run locally (disk) | PASS on parents; pending for this branch | NOT RUN | n/a |
