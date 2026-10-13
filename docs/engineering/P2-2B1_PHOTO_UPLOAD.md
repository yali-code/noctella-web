# P2-2B1: gated disk-backed product upload candidate

Relates to #384 and #377. Design: #381. Benchmark fixtures: #379 at 7c6ab55237e996fef041c60bb06f45b7d0fc2061. Linux observer adapted from #383 at 44ae46b; final CI #532 passed. No reference PR is modified or merged.

## Review scope and activation gate

This independently reviewable slice implements the real product-photo route behind PRODUCT_PHOTO_DISK_STAGING_ENABLED=true. Default remains the legacy route. Do not enable in production based on this PR. AI-intake uploads/finalization and Instagram Sharp callers are not admitted by this controller; therefore this is **not yet a process-wide image memory bound**. Product uploads share a process singleton. No storage, database schema, credentials or marketplace provider configuration changes.

The Buffer PhotoStorage and deterministic AI interfaces remain intact. A common image recipe retains rotate, inside/no enlargement, main 2000px WebP86, thumbnail 400px WebP82. Original encoded size remains sizeBytes. IDs, random storage keys, public URLs, row locking, ordering/primary selection, alt text, promotion outbox payload/transaction and backup boundaries stay unchanged. eBay/Etsy/Web consume the same persisted URLs/metadata. One integrity correction also applies to the legacy service: compensation deletes newly owned files only when its DB transaction fails, never after a committed transaction followed by a failed response read.

## Resource model

| Resource | Candidate limit | Qualification |
| --- | --- | --- |
| Encoded input | 10 MiB inclusive | Multer sentinel is max+1, followed by own exact bound |
| Raw multipart body | 10 MiB + 72 KiB | Streaming counter, no concatenation |
| Multipart | one photo, optional one altText <=8192 bytes | Unknown/nested fields rejected; parts sentinel accommodates Busboy equal-bound behavior |
| Image | 24,000,000 pixels; 12,000px each edge | Sharp input-pixel limit plus metadata checks before derivative decode; provisional, not representative-customer validation |
| Active / waiting | one / two | Reservation before DB/body/directory; FIFO after receive; 5s queue wait |
| Receive | 30s | Abort staging streams, settle writes before deletion |
| Transform alarm | 60s | Closes new admission; cannot cancel native work safely; holds permit until physical settlement |
| Private disk | 42 MiB per admitted request; 128 MiB aggregate software reservation | 10 MiB input + two capped 16 MiB outputs; three reservations =126 MiB |
| Linux hard memory / target | 512 / 384 MiB | Neither threshold may be raised to get green measurements |

Disk staging lives in a private 0700 sibling of the canonical root; files use exclusive 0600 creation. Client names never become paths. Reject symlink roots/files, public/intake overlaps and nonregular inventory. Sharp reads paths and derivatives stream through byte caps to files, without whole-input readFile or derivative toBuffer. Main and thumb publish with no-overwrite hardlinks; only newly owned files are compensated on failure. EXDEV fails closed (same-volume staging required). Root remains trusted operator configuration; do not let untrusted local actors write parent directories.

This reservation is not a filesystem quota and does not cover other processes, SQLite, intake or unrelated disk usage. Crash orphans are scanned and counted, never age-deleted blindly; unsafe inventory or exhaustion closes admission until operator recovery. Native/temp-library overhead needs Linux observation. Existing canonical bytes are never reclaimed by this request cleanup.

## Failure behavior

Invalid image/pixel limit: 400 JSON; malformed/oversize multipart: 400/413 JSON; slow receive:408; capacity/queue/storage:503 JSON with Retry-After:1. Success remains201 ProductPhoto. These replace legacy unhandled Multer500 HTML errors on the gated path. Clients must not blindly retry an ambiguous post-commit failure.

Abort cancels queued/receiving work. Active native transforms settle before lease release or work-directory deletion. Storage/cleanup failure closes future admission. If DB persistence completed, a staging-cleanup failure retains201 and saved canonical files, records a safe warning and closes admission. SIGTERM/SIGINT close the gate before existing graceful shutdown. Existing shutdown deadline can still kill native work: restart inventory protects against silently exceeding the reservation.

Crash between publication and DB commit can leave unreferenced canonical files. B1 deliberately does not delete these by age; DB/outbox-aware reconciliation remains follow-up. Crash after one link never corrupts an existing key. File cache is disabled in libvips on first candidate processing to allow Windows cleanup; this is process-wide cache policy and can affect other Sharp callers' performance, not their recipes. Default-off import does not change Sharp cache.

## Tests and acceptance

New contracts capture legacy orientation/WebP/deterministic retry bytes and post-commit compensation. Controller/transport/storage tests cover FIFO, queue timeout, fourth admission, cancellation without early native release, alarm fail-closed, exact 10-MiB boundary, oversized/extra fields/files, auth-before-staging, disk-full, orphan inventory, cleanup failure, interrupted multipart, receive timeout, JPEG/PNG/WebP alpha, dimensions/pixels, invalid input and no-overwrite publication failure. Real-app authenticated tests assert metadata/order/primary/alt, recipe byte parity and promotion outbox.

Regression suites include existing photos, outbox workflow/restart/stale-lock/scheduler, backup/recovery and deterministic AI-intake services/routes/restart. CI runs all repository tests, typechecks, builds, lint and real disposable PostgreSQL tests. See PR for executed totals and actual CI status.

The dedicated photo-upload-linux workflow is explicit workflow_dispatch or same-repository PR title edit starting [run-upload-512m]. Normal PRs only run eight fast policy tests. It builds a source-only disposable context, generates pinned synthetic fixtures, then fresh 512-MiB/no-swap/network-none/read-only-root one-CPU containers per case. It checks limits inside and outside, retains a keepalive observer on worker OOM, samples RSS/cgroup/disk, captures exact peak/events/exits and always uploads evidence. Twelve bounded smoke cases cover near-limit JPEG/PNG/WebP at client concurrency1/2/4, sequential12, invalid input and four144-MP rejects. Only fixture generation gets2GiB; generation is outside measurements.

The worker imports the actual app, seeds isolated SQLite/auth/category/product, streams loopback multipart via files and checks DB/outbox/output counts. No index schedulers, customer photos, production keys, provider calls or network access. The streaming client is in-process and shares the measured cgroup; full API startup and auth are included in peak, while a separately reported warm baseline follows setup. Runs are one trial per case, not production or full acceptance. c4 overload is expected only with PHOTO_CAPACITY_BUSY; normal cases must have successes and c1/c2 may not overload. Queue timeouts fail evidence. Exceeding384MiB or any max/OOM counter fails, even with valid outputs.

## Remaining P2-2B sequence and approval gates

1. Integrate all Sharp entry points with shared admission without deadlocking deterministic AI finalization; retain existing retry/conflict contracts. Evaluate Sharp concurrency1 explicitly with cache/thread observations.
2. Validate24MP/12000 against representative synthetic orientations/animated/corrupt/truncated formats; obtain owner approval of actual customer-facing limits without using customer media here.
3. Add real temporary-filesystem quota/free-space guard, maximum staging age ownership protocol, startup safe recovery and canonical DB-aware orphan reconciliation; inject output ENOSPC and hard-kill/restart faults.
4. Repeat Linux real-API multipart measurements at1/2/4 at least three times,30-minute soak, slow/adversarial clients,24MP photos, AI-intake combined load, dispatcher/backup overlap and near-disk-full. Include external streaming client, Linux API baseline, heap/external/native/cgroup peaks and page cache. Keep384MiB.
5. Compare two transforms only as an isolated candidate; no rollout without evidence under512MiB. Confirm admin actionable overload UX and provider payload regression snapshots.
6. Review resource results and operational recovery before separate enablement approval. No production-readiness claim from B1 smoke.

## Rollback

Leave/unset the gate to use the existing route. No migrations or key transformations to reverse. Already committed photos/outbox remain valid on either route. Before rolling back an enabled instance, drain requests, preserve staging inventory, reconcile against DB/outbox and handle only proven-owned orphans. A code revert removes the candidate without deleting canonical media. Disabling the gate alone does not bound legacy memory, and does not justify higher concurrency.
