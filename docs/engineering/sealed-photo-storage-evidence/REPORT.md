# Issue #405 measured storage-capability evidence

This is a scoped, disposable development foundation, not production writer adoption or automatic recovery. The protected boundary resolves the three inherited storage counterexamples; old unadopted APIs remain unsafe and their negative tests are deliberately retained separately. Keep PRODUCT_PHOTO_DISK_STAGING_ENABLED unset/false. Issue #396 reference/reconciliation work and #390 resource acceptance remain open.

## Source and validation

Exact parent: 23932ce4df5281561f7a14325905f3c597ce15de (#404). Tested implementation: 0c18d9813299fbc56838fdc40764a538fac9a8c8. The final delivery adds only this report and synthetic evidence; source-manifest.json records exact implementation/CI blobs and unchanged parent tree identities.

| Run | Source | Capability tests | Outcome |
| --- | --- | --- | --- |
| [CI577](https://github.com/yali-code/noctella-web/actions/runs/38576491928) | 5947254 | 41 passed, zero skips/failures | All steps passed |
| [CI578](https://github.com/yali-code/noctella-web/actions/runs/38577643331) | 3b1d8cd | 43 passed, zero skips/failures | All steps passed |
| [CI579](https://github.com/yali-code/noctella-web/actions/runs/38579084392) | 0c18d98 | 48 passed, zero skips/failures | All steps passed |

Each run also executes the unchanged35 ownership/model/baseline tests,37 crash workflow tests (all15 SQLite +15 PostgreSQL real photo workflows),51 PostgreSQL integrations, full workspace tests/typechecks/builds/lint. The35 baseline cases include five expected unsafe outcomes; they are not new production-fencing acceptance. CI577/578: API6106 passed/34 optional skips, Admin925, Storefront376, PG51, all build/typecheck/lint steps passed. Optional skips do not replace the separately executed PostgreSQL tests.

Local final protected suite:48 tests,25 passed,23 skipped, zero failures.22 skips require unavailable local PostgreSQL; one is Windows symlink privilege. Final Linux CI579 executed all48 with zero skips/failures. Local targeted legacy regressions:190 passed/one unconfigured PG skip in six suites. Local API typecheck passed. Initial local protected run had three fixture failures from a missing deterministic Buffer argument; they were fixed, and both original failures and every subsequent local evidence directory/log are retained. Initial26 tests:11 passed/3 failed/12 skipped. Windows termination evidence is not substituted for Linux SIGKILL evidence.

## Protected before/after behavior

| Inherited actual-service counterexample | New protected result |
| --- | --- |
| Existing URL-based compensation can delete newer-generation bytes | Stale ownership rejected before mutation; even current compensation retains canonical bytes. Before/after canonical hashes and exact inode identity remain equal |
| A rejected async SQLite transaction callback continues doing filesystem work | Actual callback wrapped in inherited forbidden async context; protected mutation refused before I/O even without a newer generation. Unexpected async authority callbacks also revoke their lifetime |
| Older deterministic preparation overwrites newer main then conflicts on thumbnail | Producer writes only its generation/attempt-private namespace; stale seal/publication rejected; different input hash refused. Sealed publication links exclusively and never overwrites either destination |

Complete original baseline traces/hashes are in photo-operation-fencing ZIPs; protected traces are in photo-storage-capability ZIPs. Tests use real product and deterministic storage implementations and unchanged recipes. Tiny32x24 red PNG/JPEG/WebP fixtures preserve output dimensions/format; they establish storage compatibility, not24MP fidelity/performance acceptance.

The positive matrix includes independent publisher processes, lease expiry/ABA, stale generations, immutable source/owner snapshots, inode replacement, canonical symlinks, changed physical roots, same-inode marker nonce replacement, disk-full marker creation, marker cleanup failure, zero output, historical outbox-only references, ambiguous acknowledgement, sealed/raw descriptor isolation and retry idempotency. Six killed checkpoints per engine: intent, raw input, seal before registration commit, registered seal, first canonical link, returned publication. Linux asserts the actual SIGKILL signal. At uncertain mutation checkpoints the marker remains review-required; no automatic removal is attempted.

The PostgreSQL disconnect regression terminates only its own synthetic worker connection (PID + unique application_name + current test database). A later claim remains blocked despite loss of the DB row lock while old I/O may run. The first callback can still publish at the current generation, then COMMIT fails. Only after callback settlement/physical worker close does reclaim proceed; same-input retry preserves the original canonical hashes/inodes. This does not claim DB rollback undoes filesystem writes or that timeout cancels native I/O.

## Disk evidence and limitations

Inventory fields distinguish bytes from allocated blocks. Deduplicate by device/inode: raw/work aliases and canonical/sealed aliases do not create another payload copy on the measured Linux filesystem. Seals intentionally have independent inodes from raw encoder outputs. Unique-photo payload bytes/allocated blocks for final cases are recorded in final-results.json; DB/WAL, JSON logs and retained older attempts are excluded from that photo-only figure. ZIP extraction does not preserve inode identity, so use recorded source inventories rather than measuring extracted hardlinks.

Conservative theoretical per-attempt payload bound:10MiB input +2x16MiB raw +2x16MiB independent seals =74MiB before DB/WAL/metadata/previous attempts. Canonical hardlinks add no third payload. This exceeds the existing42MiB ingress reservation; HTTP adoption requires separate capacity validation. Retention reclaims zero bytes by design. No production disk improvement or memory acceptance is claimed; no24MP memory benchmark was run for this storage task.

## Scope, risks and rollback

The module can only be constructed for test/development with the gate explicitly true and disjoint guarded temporary roots. Concrete DB authority adapters/probe tables exist only in fixtures. Existing default producers retain their public signatures/default roots; no routes/providers/schema/migrations/config defaults are changed. Parent branches remain unchanged. No production/provider/customer/Render access occurred.

All participating claims and mutations must share the same trusted private marker roots and durable authority. Markers serialize the physical section independently of lease expiry. A crashed marker blocks indefinitely for operator review. This is not protection against malicious same-UID/root code or manual marker deletion, and direct legacy writers bypass the protocol. Marker comparison/unlink is not a portable atomic compare-delete primitive against hostile host mutation. Canonical photo unlink is absent.

Not delivered: AI-original/Instagram/default HTTP/all-outbox/cleanup adoption, production DB clock/pool provider, automatic restart recovery, reference census, deletion/quarantine, disk budget enforcement or full-API384MiB resource acceptance. Those are explicit rollout blockers. Green CI validates the scoped development boundary only.

Rollback: remove the new development module/private-root helper/test/CI changes. No production migration or enabled flag exists. Preserve retained markers/private generations/seals/canonical files and authoritative DB/outbox evidence. Never reopen a crashed marker by age/PID/zero-size or remove files automatically.

## Evidence integrity

All local run directories (including failures) are archived, and original UTF16 Windows transcripts are copied without re-encoding. Each original GitHub ZIP is retained byte-for-byte and verified against its API SHA256. archive-manifest.json records all archive sizes/hashes/entry counts/JSON validation counts. Raw evidence is synthetic and permanently committed so Actions artifact expiry does not erase it. source-manifest.json distinguishes the tested revision from documentation/evidence-only delivery.

## Final source acceptance

CI579 PASSED on exact source0c18d9813299fbc56838fdc40764a538fac9a8c8. New48 + inherited35 + crash37 + PostgreSQL51 passed with zero failures/skips in those suites. API6106 passed/34 optional skips; Admin925; Storefront376. All workspace typechecks/builds/lint passed.47 named protected checkpoints and12 actual Linux SIGKILL records validate in the archived source evidence; the feature-OFF construction test records final-state only. Both engines' inode-isolation fixtures recorded328 unique WebP payload bytes across4 inodes and16384 allocated bytes (four4KiB allocations), excluding input/DB/WAL/metadata. Raw versus sealed copies each use independent payload; canonical hardlinks add no payload. These tiny synthetic measurements are not production capacity results.
