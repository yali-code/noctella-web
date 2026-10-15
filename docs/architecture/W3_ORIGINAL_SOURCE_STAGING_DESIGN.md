# W3 original-source staging: integration design (#390)

Status: **design only**. Nothing here is implemented in application code, and nothing here authorizes
production activation. Evidence comes from isolated experiments (PR #415, #416, #417). The application
inventory below was read from `main` at `7df99ba`.

## 1. Why

On a 512 MiB instance, the live W3 AI-intake upload re-encodes the full 24 MP upload as WebP q86. libwebp
then holds the whole-image token buffer (~209 MiB) plus a 34 MiB YUV picture. The best output-identical
result was 411.43 MiB (patched libvips + glibc arena1, PR #416). Original-source staging stores the
validated upload instead, so W3 has no full-resolution encode.

| Isolated 24 MP combined workload, 512 MiB, no swap, 8 operations | Peak |
| --- | --- |
| Live WebP-first (npm libvips, glibc arena1) | 461–483 MiB |
| Live WebP-first + patched libvips + arena1 (PR #416) | 411.43 MiB |
| Original-source staging, npm libvips, default glibc (PR #417, run 38712899384) | 322.26 / 319.70 / 337.81 MiB |

The #417 trials had zero OOM and zero memory-limit events, and the declared parity passed: only the 2
staged sources and the W4 main and thumbnail changed. All other outputs stayed byte-identical. This is an
experimental result, not production readiness.

## 2. Current W3/W4 dependency map (main)

| # | Consumer | File | Relies on |
| --- | --- | --- | --- |
| 1 | W3 upload | `routes/aiProductIntakes.ts` POST `/:id/photos` → `services/aiIntakePhotos.ts` → `services/aiIntakePhotoStorage.ts` | memory multer (10 MiB) or disk ingress (`PRODUCT_PHOTO_DISK_STAGING_ENABLED`). Validation = declared-MIME allow-list (jpeg/png/webp) + size; anything Sharp decodes is accepted (e.g. PNG declared as JPEG). `sharp(..., {failOn:"error"}).rotate().webp({quality:86})`. Metadata stripped by Sharp's default |
| 2 | Private representation | `aiIntakePhotoStorage.ts` | root `AI_INTAKE_PHOTO_DIR` (default `uploads/ai-intake-photos-private`), key `${uuid}.webp`, 0600 `wx` reservation under admission; not served statically (`app.ts` mounts only the product-photo root) |
| 3 | Admin content | GET `/:id/photos/:photoId/content` (`ai_product_intakes.view`) → `getIntakePhotoContent` → `readIntakePhoto` | returns the **raw staged bytes** with a hard-coded `Content-Type: image/webp`, `no-store`, `nosniff` |
| 4 | AI provider | `services/aiIntakeGeneration.ts` passes `LocalAiIntakePhotoReader` (`ai-intake/photoReader.ts`) to the provider; context exposes only `id`, `originalFilename`, `referenceId` | **raw staged bytes** (today the mock provider never reads them) |
| 5 | W4 finalization | `services/aiIntakePhotoFinalization.ts` → `use-cases/ai-intake-photo-finalize` → `writeDeterministicProductPhoto` (`photoStorage.ts`) | same raw reader as #4; labels bytes `image/webp`; validates ≤10 MiB; `.rotate()` → 2000 px q86 + 400 px q82 WebP at `${productId}-${photoId}(.webp|-thumb.webp)`; idempotent write (identical bytes no-op, different bytes conflict) |
| 6 | Naming/MIME | `use-cases/ai-intake-cleanup` `PRIVATE_STAGED_FILENAME_RE = ^UUID\.webp$`; route MIME header; W4 MIME label | suffix `.webp` everywhere |
| 7 | `sizeBytes` | `product_photos.size_bytes` from W4 = staged byte length (W1 product uploads store the upload size) | — |
| 8 | DB/outbox | `ai_intake_photos(id, intake_id, storage_key TEXT, original_filename, created_by, timestamps)`: no MIME/size columns; W4 commits product_photos + outbox in one transaction; photo-set fingerprint hashes photo **ids** only | storage_key is free-form TEXT |
| 9 | Cleanup/retention | `services/aiIntakeCleanup.ts` + use case: retention deletes staged files of cancelled/finalized intakes **by DB row key**; the orphan sweep deletes only `^UUID\.webp$` names without rows after a grace period; other names are counted `unknownFilesRetained` and **kept** | open/applied intakes are retained indefinitely |
| 10 | Retry/recovery | upload: file first, row second, file deleted if the row insert fails; W4: files prepared outside the transaction, deterministic keys, idempotent | — |
| 11 | Legacy | every staged file today is `${uuid}.webp` | — |
| 12 | Backup | product-photo backup reads `PRODUCT_PHOTO_DIR` keys only; DB backup copies rows; **the private intake root is in neither** | a restored DB can reference missing staged files (existing behaviour) |
| — | Also | `storageKey` is returned in admin API JSON (`AiIntakePhoto.storageKey`, string); admin UI tests assert it is not rendered | value shape changes, type does not |

## 3. Security and privacy design

Three access classes, each with one entry point:

- **A. Private original (`AiIntakePhotoSourceReader`, internal).** Raw bytes, used only by W4 inside image
  admission. Never returned by a route and never handed to a provider. Key validated by a generation-aware
  regex, `lstat` regular file, realpath containment (existing `managedFileDeletion` policy).
- **B. Safe preview (`AiIntakePhotoPreviewReader`).** Used by the admin content route and every AI
  provider:
  - original-source keys: `rotate()` → max 2048 px inside → WebP q86, Sharp default (no EXIF/GPS/XMP/ICC
    passthrough), under admission;
  - legacy `.webp` keys: served as stored (already metadata-free) so legacy behaviour and memory are
    unchanged;
  - `Content-Type: image/webp` stays truthful in both cases.
- **C. W4 input.** A uses the source reader. W4 consumes private originals in-process and writes only
  metadata-free derivatives, so it adds no new external exposure. Verify with a marker test on W4 outputs.

Invariants:

- **Content-verified MIME.** The decoded container format must equal the declared allow-listed MIME (stricter
  than today: a PNG declared as JPEG is rejected).
- **Fail closed.** Full streaming decode with `failOn:"error"` (no encode), the 10 MiB limit and Sharp's
  default pixel limit. Malformed, unsupported or format-mismatched input → 400, nothing left on disk.
- **Animated WebP** (`pages > 1`): fall back to the legacy WebP-first path, so behaviour stays page 0 and
  stored bytes stay metadata-free. Small animated files do not hit the memory problem.
- **Writes.** 0600 exclusive `.${uuid}.partial` → fsync → `link` (no clobber) → unlink → directory fsync.
  Crash leftovers are swept only by the exact partial regex after a grace period.
- **Auth.** Authentication and authorization are unchanged: same routes, same permissions, no new route,
  no static mount.
- **Retention.** Originals contain GPS and serial numbers: bounded and auditable retention is required for
  **open** intakes too (owner decision), with counters in the cleanup report.

## 4. Backward compatibility (mixed generations)

- **Keys:** `${uuid}.webp` (legacy) and `${uuid}.orig.(jpg|png|webp)` (original). The generation comes from
  the key suffix, and every read cross-checks the decoded format.
- **No database migration needed.** `storage_key` is TEXT, the photo-set fingerprint uses ids, and no MIME
  or size column exists. The admin API keeps the same field and type; only the key text differs.
- **Cleanup:** the orphan sweep must recognise both key regexes plus the partial regex, so new orphans are
  not retained forever. Retention by DB row already works for any key.
- **Legacy finalization:** unchanged. W4 reads the legacy WebP exactly as today, so existing intakes produce
  exactly today's bytes.
- **Idempotency:** a photo keeps its generation for its lifetime, and W4's deterministic keys and
  byte-compare are unchanged.
  - Retrying W4 on the same staged source reproduces identical bytes.
  - Switching the flag never changes an existing photo's source.
- **Outbox/DB:** unchanged. W4 still commits product_photos + outbox atomically, and only file preparation
  reads a different source.
- **Backup:** neither generation is backed up today. Adding originals to backups would copy GPS data and
  needs an explicit owner decision (encryption, retention). Recommendation: keep staging out of backups,
  as today.

## 5. Image quality

- **Measured (run 38709477114, final W4 main, WebP-first vs original-source):**

  | Input | PSNR | SSIM |
  | --- | --- | --- |
  | JPEG 24 MP | 34.66 dB | 0.818 |
  | PNG | 31.49 dB | 0.869 |
  | EXIF/P3/orientation-6 JPEG | 39.15 dB | 0.912 |

  These measure difference, not quality. The quality signal is each workflow versus the lossless reference
  (`fidelity.json` → `vsReference.psnrA/psnrB`, `ssimA/ssimB`). That still has to be reviewed. Expected:
  original-source is closer to the source, because it removes one full-resolution lossy generation. Not
  verified here.
- **Consequence:** under original-source, the W4 outputs equal the direct product-upload outputs for the
  same file (byte-identical in #417). Existing finalized products are unaffected, because their files
  already exist and are never regenerated.
- **Orientation:** both paths auto-orient exactly once (W3 bakes it in today; W4 `.rotate()` reads EXIF
  under original-source). Equal dimensions are expected; the gate checks it on the orientation-6 fixture.
- **ICC:** both paths convert to sRGB once and strip the profile. Verify `hasIcc=false` and visual
  equivalence on the P3 fixture (gate 4).
- **Thumbnails:** same recipe in both paths. The difference comes only from the different source generation.
- **WebP-first intermediate-size failure** (confirmed by the PR #417 fidelity run, as reported by the
  owner's reviewer):
  - The live W3 re-encodes a near-10 MiB 24 MP WebP into a staged WebP over 10 MiB.
  - W4 then rejects it ("Product photos must be 10 MB or smaller"), so such an intake can never be
    finalized.
  - Original-source staging cannot hit this: staged bytes are the upload, which is ≤10 MiB.
  - This is an existing live defect, independent of #390's memory gate.
- **`sizeBytes`** becomes the upload size, matching W1 product uploads. A semantic change for AI-finalized
  rows (owner decision).

## 6. Implementation proposal (small stacked Draft PRs, all default-OFF)

| PR | Change | Files | Tests | Flag/compat | Rollback | Owner approval |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Generation-aware key module + cleanup recognition (orphan sweep accepts legacy, original and partial regexes) | new `services/aiIntakeStagedKey.ts`; `use-cases/ai-intake-cleanup/useCases.ts` | key/regex unit tests; cleanup tests for mixed roots, symlinks, grace | no behaviour change while no original keys exist | revert | no |
| 2 | Reader split: `AiIntakePhotoPreviewReader` for the admin route and provider; source reader for W4 only | `ai-intake/photoReader.ts`, `aiIntakePhotos.ts`, `aiIntakeGeneration.ts`, `aiIntakePhotoFinalization.ts`, route | marker tests (EXIF/GPS/serial absent) for both generations; auth tests unchanged; legacy content byte-identical | legacy bytes unchanged | revert only while no original keys exist | yes (provider contract) |
| 3 | Original-source W3 writer behind `AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED` (unset/`false` = OFF; invalid value = OFF + warning); animated → legacy path | `aiIntakePhotoStorage.ts` (+ #414 writer census/fencing update) | validation matrix (mismatch, truncated, random, oversize, SVG/TIFF, pixel limit), atomic write and crash sweep, ingress path, admission | OFF = identical behaviour | flag OFF | yes |
| 4 | W4 MIME from verified content, not the `image/webp` label; `sizeBytes` decision | `aiIntakePhotoFinalization.ts` / use case | mixed-generation finalize, idempotent retry, conflict | legacy unchanged | revert | yes (`sizeBytes`, W4 bytes) |
| 5 | Acceptance harness on the real flag (no monkeypatch): 3 Linux trials + fidelity + privacy | `scripts/photo-upload-linux` | gates 1–7 | — | — | — |

## 7. Production readiness gates (all objective)

1. **Full API integration.** All existing API tests pass with the flag OFF and ON. New tests pass for upload,
   list, content, generate, finalize, delete and retry under both generations.
2. **Mixed generations.** One database with legacy and original photos: finalize, content, delete, retention
   and orphan sweep all succeed. Legacy W4 bytes are byte-identical to today.
3. **Non-disclosure.** Synthetic EXIF/GPS/serial/make markers are absent from:
   - admin content responses;
   - provider reader output;
   - W4 main and thumbnail;
   - API JSON.

   Raw markers are present only in private staging.
4. **Quality.**
   - `vsReference` PSNR/SSIM for original-source ≥ WebP-first on every fixture, or a written owner
     acceptance of each regression.
   - Orientation-6 and P3 fixtures: dimensions and orientation correct, `hasIcc=false`.
   - Owner visual sign-off.
5. **Retention/cleanup.**
   - Zero unknown or retained experimental files after the cleanup tests.
   - Partial files swept after the grace period.
   - A bounded retention for open intakes is defined and tested.
6. **Backup/recovery.** Documented decision. If staging stays excluded, a restore drill shows rows without
   files fail closed (404 / finalize error), with no crash and no data loss.
7. **Resources.** Three fresh Linux trials:
   - 512 MiB hard limit, no swap, no network;
   - the unchanged 24 MP 8-operation workload;
   - each peak ≤384 MiB;
   - zero OOM and memory-limit events;
   - DB/outbox/cleanup assertions passing;
   - declared parity only.
8. **Staging.** Deploy flag OFF, verify; then flag ON, verify gates 1–7 on staging data; then flag OFF and
   rollback, verify mixed reads.
9. **Owner approval** recorded before production activation. Experimental success (#417) does not satisfy
   any gate.

## 8. Rollback

- **Flag OFF:** new uploads return to WebP-first immediately.
- **Existing original-source photos** stay readable only while PR 1, 2 and 4 code is deployed. Never roll
  code back below PR 2 while any `.orig.*` key exists: older code would serve raw originals with EXIF/GPS
  as `image/webp` and would retain orphans.
- **Before such a rollback,** drain original-source keys:
  - finalize or cancel the intakes; or
  - run an offline conversion to legacy WebP (memory-heavy, off-peak, separate approval).
- **No database rollback is needed.**

## 9. Owner decisions required

1. Accept changed W4 bytes for new AI-finalized photos, after reviewing gate 4.
2. Privacy: retaining raw originals with GPS/serial in private staging, and the retention period for open
   intakes.
3. Provider contract: providers receive only bounded, metadata-free previews (2048 px).
4. `sizeBytes` semantics for AI-finalized photos.
5. Backups: keep private staging excluded, or include it (encryption and retention).
6. Animated WebP: legacy-path fallback, as proposed, or rejection.
7. Fix the WebP-first oversize defect for the flag-OFF path (e.g. a W4 input-size rule for legacy staged
   files) separately from #390.
8. Ordering relative to #413/#414 (writer census, fencing) and W4 integration.
