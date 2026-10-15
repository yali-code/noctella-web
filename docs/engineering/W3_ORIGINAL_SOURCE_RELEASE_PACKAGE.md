# W3 original-source staging: integration and release package (#390)

Status: **not production-ready.** Nothing has been merged, deployed or activated, and no migration has run.
`AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED` defaults OFF. It cannot be activated outside NODE_ENV test or
development until the owner approves the raw-original retention contract (§7). Design:
`docs/architecture/W3_ORIGINAL_SOURCE_STAGING_DESIGN.md` (PR #418, branch
`docs/w3-original-source-staging-design-390`).

## 1. Stack and merge order

| Order | Branch | Base | Content | Status |
| --- | --- | --- | --- | --- |
| 0 | `feat/photo-storage-final-readiness` (#413) | stack below | readiness/recovery evidence | open; one accidental commit pending owner remediation |
| 1 | `feat/photo-storage-production-completion` (#414) | #413 lineage | ownership schema 0040, fail-closed refusals, W1/W10/W8/W9 corrections, writer census | open; production gates in `PHOTO_STORAGE_RELEASE_READINESS.md` §10 |
| 2 | `feat/w3-safe-staged-readers` | #414 | Stage 1: key generations, exposure-safe readers (admin and provider), private W4 reader, mixed cleanup | ready for Draft PR |
| 3 | `feat/w3-original-source-writer` | stage 1 | Stage 2: flagged writer (fenced to test/dev), W4 verified MIME, census update | ready for Draft PR |
| 4 | `feat/w3-original-source-acceptance` | stage 2 | Stage 4: integrated 24 MP profile `combined-original-source`; this package | ready for Draft PR |

Experiments #415, #416 and #417 are evidence only and are never merged. The design PR #418 is docs-only and can
merge independently.

- **Merge order:** #413 → #414 → stage 1 → stage 2 → stage 4, each after its own CI.
- **Conflicts:** stages 1–4 touch only AI-intake staging files, the W4 manifest MIME line, the writer census,
  the combined probe and the Linux harness. A rebase is needed only if #414 changes the same lines.
  `photoStorage.ts`, routes, schema and migrations are untouched.

## 2. Required CI before any merge

1. **API typecheck, build, full `vitest run`:** SQLite in CI. PostgreSQL via `test:postgres` where #414
   requires it; stages 1–4 add no PostgreSQL-specific code or schema.
2. **Writer census and harness tooling tests** (`scripts/photo-writer-adoption`, `scripts/photo-upload-linux`).
3. **Linux 512 MiB acceptance on stage 4.** Retitle the stage 4 Draft PR to
   `[run-upload-512m] combined-original-source-only …`. Pass criteria:
   - three fresh trials, 8/8 operations each;
   - each cgroup peak ≤384 MiB;
   - zero OOM / `oom_kill` / `max` events;
   - integrity assertions (rows 4, outbox 4, AI rows 2, private files 2, admission drained, cleanup);
   - original-source parity assertions: staged key `.orig.jpg` with the upload's SHA-256, and W4 main and
     thumbnail byte-identical to the product-upload derivatives;
   - `summary.status = PASS`.
4. **Regression:** the existing `combined` profile is unchanged and still the flag-OFF baseline (it FAILs the
   memory gate today, #397).

## 3. Stage 3 (#396–#407) reconciliation

Every crash-safety branch (P2-2B3 … P2-2B3D5) is contained in #414. What remains open is listed in
`PHOTO_STORAGE_RELEASE_READINESS.md` §10 and is unchanged by this stack:

| Item | State |
| --- | --- |
| W4 AI finalization fencing (#405) | BLOCKED: production wiring was refused three times by the automated safety review; needs owner-applied patch or a supported approval path |
| W2 staged-upload fencing | BLOCKED: no request-stable operation id |
| W3/W7/W11/W12 adoption | BLOCKED. W3 original-source writes stay private and unfenced, like today's W3 |
| Disk budget in production writers (#407) | development capability only; sizing decision open. The original-source writer copies ≤10 MiB per upload into private staging, not budgeted |
| Ambiguous AI source recovery (#398) | recovery classifier is development-only. Original-source keys are recognised by cleanup; operator workflow not authorized |
| PostgreSQL photo workflow (#402) | 0040 numbering versus Etsy 0039 unresolved; stages 1–4 add no migration |
| `fix/photo-recovery-bounded-disk-p2-4a` (`e3f1607`) | exists only locally, never pushed: needs triage |

These remain release blockers for photo-storage activation. The original-source stack does not resolve or
weaken them.

## 4. Security gates (original-source)

| Gate | Evidence | State |
| --- | --- | --- |
| Raw originals never served or sent to providers | stage 1 tests: admin route and provider reader return metadata-free previews; legacy bytes unchanged | PASS (unit/route) |
| EXIF/GPS/serial/ICC absent from exposed outputs | stage 1 and 2 marker tests (route, provider, W4 main and thumbnail) | PASS (unit) |
| Content-verified MIME, fail closed | stage 2 rejection matrix | PASS (unit) |
| Symlink, traversal, non-file refusal | stage 1 tests (symlink cases skip on Windows, run in Linux CI) | PASS / CI pending |
| Auth unchanged | stage 1 route 401/403 | PASS |
| Retention of raw originals for open intakes | not defined | **BLOCKED (owner decision)**; the production fence enforces it |

## 5. Staging verification (requires owner authorization; not executed)

1. Back up the DB (`npm run db:backup -w apps/api`). The private staging root is not covered by any backup.
2. Deploy with the flag unset. Verify upload, content, generate, finalize, delete and cleanup on synthetic
   intakes; staged keys stay `<uuid>.webp`.
3. Lifting the test/development fence is a code change that needs the retention approval. Only after it:
   - set `AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED=true` and restart;
   - repeat step 2 with an EXIF/GPS synthetic JPEG;
   - verify `.orig.*` keys, content responses without markers, and W4 outputs.
4. **Mixed generations:** finalize an intake holding one legacy and one original photo.
5. **Rollback drill:** unset the flag and restart. Existing `.orig.*` photos must still preview and finalize.
   Never deploy code older than stage 1 while `.orig.*` keys exist.
6. **Memory:** the stage 4 Linux profile on the exact build.

## 6. Monitoring and alerts (proposed)

| Metric | Alert |
| --- | --- |
| Container memory peak / OOM restarts (Render) | any OOM or exit 137; peak >384 MiB for 5 minutes |
| AI-intake upload 4xx "valid image" rejections | >5 % of uploads in 1 h (stricter validation regression) |
| Content/preview 5xx ("could not be read") | any |
| `unknownFilesRetained` and partial files in the cleanup report | >0 after one grace period |
| Private staging disk usage | >80 % of the disk free-space floor |
| W4 `AiIntakePhotoFinalizationSourceMissingError` | any |

## 7. Owner decisions and approval checklist

1. Raw-original retention for open intakes (period, audit). This is the prerequisite for lifting the
   production fence.
2. Accept changed W4 bytes for new AI-finalized photos. Review the #417 fidelity evidence, and confirm the
   vs-reference metrics.
3. `sizeBytes` = upload size for original-source photos (matches W1).
4. Keep private staging out of backups (recommended), or define encrypted retention.
5. Animated WebP: keep the WebP-first fallback (implemented) or reject.
6. Separately fix the live WebP-first defect (a staged WebP over 10 MiB is rejected by W4).
7. #413 remediation, W4 fencing path, Render single-instance confirmation, 0040 numbering (from #414).
8. Final sign-off: every gate in §2, §4 and `PHOTO_STORAGE_RELEASE_READINESS.md` §10 recorded, before any
   production activation.
