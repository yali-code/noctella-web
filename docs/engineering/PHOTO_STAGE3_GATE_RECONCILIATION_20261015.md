# Photo Infrastructure — Stage 3 release-gate reconciliation (2026-10-15)

**Evidence classification:** engineering coordination only. **NO production release authorization, merge, migration, cleanup or flag activation.** This note does not supersede historical measurements in `PHOTO_STORAGE_RELEASE_READINESS.md`, `PHOTO_STORAGE_RELEASE_RUNBOOK.md`, or `W3_ORIGINAL_SOURCE_RELEASE_PACKAGE.md`; those documents were written against older commits and preserve their own provenance.

## Verified current stack (all OPEN / DRAFT)

| PR | Role | Head SHA at verification | Base |
| --- | --- | --- | --- |
| #413 | development fenced-finalize and recovery proof | `d93d281f` | `feat/photo-legacy-writer-gates-p2-2b3d6` |
| #414 | registered ownership tables / fail-closed guards | `5320489b` | `feat/photo-storage-final-readiness` |
| #419 | W3 safe staged readers | `c0445929` | `feat/photo-storage-production-completion` |
| #420 | default-OFF original-source writer | `f89c7deb` | `feat/w3-safe-staged-readers` |
| #421 | integrated synthetic Linux acceptance harness | `74bfa9da` | `feat/w3-original-source-writer` |
| #422 | SQLite transient-file observer ENOENT correction | `b7285a52` | `feat/w3-original-source-acceptance` |

## #390 memory gate: accepted scope versus remaining scope

- **PASS for the exact #422 candidate**: GitHub Actions [38738035796](https://github.com/yali-code/noctella-web/actions/runs/38738035796), `photo-upload-linux-38738035796-1` (artifact ID `11973619588`). Three integrated **synthetic** near-24-MP `combined-original-source` Linux 512-MiB/no-swap trials: **318.56 / 323.55 / 314.99 MiB** peak; 8/8 operations per trial; zero OOM; `summary.status=PASS`. Observer regression tooling tests PASS.
- Earlier #421 run [38736009701](https://github.com/yali-code/noctella-web/actions/runs/38736009701) was inconclusive at the sampler because an SQLite `api.sqlite-shm` vanished during `lstat`; the worker memory numbers were below threshold. Do **not** erase that failure.
- The isolated #417 benchmark and historical #397 failing WebP-first profile are **different recipes or evidence levels**; neither substitutes for full production acceptance. #422 does not establish a 30-minute soak, real staging image backup/restore, PostgreSQL end-to-end, full security regression or release authorization.
- **Acceptance for the current stack is tied to SHA `b7285a52`**. Any further runtime/harness changes require checking their effects and rerunning relevant acceptance.

## Stage 3: unresolved critical safety gates

| Gate | Verified implementation boundary | Required evidence / action before release |
| --- | --- | --- |
| W4 AI deterministic finalization fencing (#405) | `PHOTO_OWNERSHIP_FENCING_ENABLED` explicitly **does not fence W4** in #414. In `ai-intake-photo-finalize/useCases.ts`, deterministic file preparation runs outside the authoritative DB transaction, with canonical keys derived from staged IDs. | Independently authorized live writer integration: durable operation/generation authority, no-overwrite seal and ownership commit consistent with the DB transaction; kill/restart, stale-writer and lost-commit proofs on actual paths. No inference of safety from disposable harness. |
| W2 stable operation ID (#407) | Staged upload still lacks client/request-stable identity and path-fed protected admission in release report. | Design and test retry-key semantics, duplicate/conflict and crash-after-commit scenarios without changing existing client contracts silently. |
| W3/W7/W11/W12 and other writers (#407) | Not all canonical/private writers or deletion paths use fenced storage. #414's gate refuses some paths; it is not an all-writer adoption implementation. | Updated 14-writer census and actual code-path adoption evidence; prove no unprotected overwrite/delete while flag ON. |
| Disk budget and retained generations (#407) | Development-only storage admission evidence, not production all-writer accounting. | Verify in-flight + retained bytes, DB WAL, retry concurrency, ENOSPC and disk floor on actual writers; fail closed without releasing unowned data. |
| Crash and ambiguous ownership (#396/#398) | Development-only read-only classifier; ambiguous bytes retained, not autonomously cleaned. | Actual DB/outbox + filesystem restart proofs; operator-review policy and non-destructive recovery with ownership evidence. |
| PostgreSQL ownership schema (#402/#414) | SQLite `ensureSchema` registers ownership tables at startup even when flags are OFF; proposed PostgreSQL `0040` exists in #414. | Verify migration order against Etsy `0039`, current main and existing DB; transactional PG tests and restore drills before any authorized deployment. |
| Raw-original retention and rollback (#390) | Private originals may contain EXIF/GPS/serial metadata. Flag OFF alone does not roll back older reader compatibility while originals exist. | Owner-approved retention period/backups; metadata-safe reader tests; mixed-generation upgrade and rollback; no old binary while `.orig.*` remains. |
| Old Render instances / background writers | Cooperative gates cannot constrain old binaries that do not read them. | Platform evidence of complete old-instance drain and inventory of disk-writing workers; production approval separately required. |

## Next independent engineering acceptance batch

1. Gather Claude's final five-stage report and exact latest branch SHA, review regressions against the table above, and avoid writing to Claude's active worktrees.
2. Run targeted W4 authority, lost-COMMIT, stale-writer, PostgreSQL and all-writer-census tests in disposable environments; require full-suite CI before claiming Stage 3 complete. No need to rerun the existing passing #422 512-MiB profile without a relevant change.
3. For any remaining writer change: isolate in a new stacked Draft PR, preserve fail-closed default-OFF behavior, include fault-injection and evidence, then review independently.
4. Retain **release BLOCKED** until every Stage 3 gate, integrated API/PG/security tests, staging and owner decisions are satisfied.

**Important:** Do not enable `PHOTO_OWNERSHIP_FENCING_ENABLED` as if it made W4 safe; #414's runbook describes it as only a partial emergency stop. A default-OFF deployment still applies SQLite ownership schema through `ensureSchema`.
