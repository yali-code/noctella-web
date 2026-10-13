# P2-1 product photo memory benchmark and P2-2 proposal

Tracking: #373. Next-stage gates: #377. Status: offline evidence for review; no runtime changes or production acceptance.

## Recovered work and evidence provenance

Claude's local branch was `feat/etsy-phase2-photo-memory-benchmark`, based on main `7df99ba`.
The uncommitted npm command, runner, five benchmark modules and tests were recovered intact.
Before editing, these files were copied to ignored `p2-1-handoff.local/`; source hashes are in
[recovery-provenance.json](p2-1-evidence/recovery-provenance.json).

The original log reached **35/35**, and a complete JSON/Markdown report existed. All 35 scenarios
had results, no child crashes and successful scenario/work-root cleanup. There was no unfinished
scenario 6 to resume. Process inspection found no benchmark command line; one inaccessible Node
process dated September 22 was left untouched. The original fixture directory had already been
removed by the runner; no original generated fixture directory was found.

The original evidence is preserved without rewriting its incorrect expectation flags:

- [Original JSON](p2-1-evidence/photo-memory-full-2026-10-13T10-58-12-651Z.json)
- [Original Markdown](p2-1-evidence/photo-memory-full-2026-10-13T10-58-12-651Z.md)
- [Original progress log](p2-1-evidence/claude-original-progress.txt)
- [Supplemental JSON](p2-1-evidence/photo-memory-full-2026-10-13T12-41-46-546Z.json)
- [Supplemental Markdown](p2-1-evidence/photo-memory-full-2026-10-13T12-41-46-546Z.md)
- [Supplemental console transcript](p2-1-evidence/codex-supplement-progress.txt)
- [Per-scenario measurement index](p2-1-evidence/measurement-index.json)

Two tooling defects required correction:

1. Original `png-near-limit` was **14,777,113 bytes (14.09 MiB)**, exceeding the 10 MiB input cap.
   Its single, sequential-near-limit and three concurrent PNG scenarios measured size rejection,
   not accepted PNG processing. The corrected PNG is **10,026,026 bytes (9.56 MiB)**, 2350x1500,
   seeded with the same noise settings. These **five scenarios alone** were rerun. The original
   rejected measurements remain available, but are excluded from accepted-image comparisons.
2. GIF-declared MIME with valid PNG bytes was correctly rejected by production validation, but
   the generator expected success. This is an expectation correction only; its measured result
   was retained without rerunning. PNG bytes declared as JPEG remain accepted, as observed.

All other generated fixture hashes matched the original run. New generation guards enforce
declared byte targets and 9-to-10 MiB near-limit inputs. Unsupported declared MIME types are now
expected to fail. Supplemental fixture bytes and their manifest remain in
`p2-1-handoff.local/corrected-fixtures`; they are synthetic, retained locally and excluded from Git.
Progress output on stderr produced a PowerShell NativeCommandError transcript and wrapper exit 1
for the supplemental invocation; the original native exit status was not separately captured.
Both durable reports and every operation were inspected: all five results exist, every operation
succeeded, there were no crashes, and all temporary scenario directories were removed. No extra
measurement rerun was justified by that wrapper behavior.

## Environment and methodology

Both measurement runs used Node **v24.18.0**, Sharp **0.34.5**, libvips **8.17.3**, Windows
**10.0.26200 x64**, an Intel Core **i5-3210M at 2.50 GHz / 4 logical CPUs**, and **8066 MiB** host RAM.
UV_THREADPOOL_SIZE was default (4); default Sharp concurrency was 4 and SIMD enabled.
No 512-MiB process/container cap was imposed or verified. The runs began at **13:58:12** and
**15:41:46 Europe/Istanbul on October 13, 2026** (raw reports retain UTC timestamps).

Each scenario runs in a fresh child with a minimal environment and isolated PRODUCT_PHOTO_DIR,
TMP/TEMP/TMPDIR. Inputs use seeded synthetic gradients/noise or flat colours, JPEG/PNG/WebP,
portrait/landscape, 9.22/9.56/9.38 MiB near-limit images, 64/144/289 MP stress inputs and malformed
files. No customer photos, database, credentials, marketplace requests or real S3 operations are
used. The unmodified `services/photoStorage.ts` generates the <=2000px main and <=400px thumbnail.

Per in-flight operation, the worker reads one whole input into a Buffer to model the existing
Multer memory-storage handoff. It invokes either saveProductPhoto or deterministic AI-intake
finalization. Concurrency means uploads in flight within one child, not simultaneous scenario
processes. It records file sizes and operation outcomes, 5-ms sampled RSS/heap/external/ArrayBuffer
peaks, and OS-reported process maximum RSS. Reported peak RSS is the greater of those RSS values.

Operation duration covers the unchanged photo service call, including validation, Sharp and
output writes; it excludes fixture read and later output stat. Total scenario duration includes
input reads and stat. This does **not** isolate Sharp CPU time or HTTP/multipart latency. Output
main/thumbnail sizes are actual stat sizes; rounded averages below are backed by per-op JSON.

## Results for all 35 effective scenarios

Run B = recovered baseline; S = corrected five-scenario supplement. This is a provenance-aware
combination of two runs, not a claim that the corrected matrix was measured in one invocation.
There are **155 operations: 148 successful transforms and 7 expected rejections**. Every effective
scenario has verified output counts, no unexpected temp files and successful directory cleanup.

| Scenario | Run | In flight | Succeeded/ops | Peak RSS MiB | Heap MiB | External MiB | ArrayBuffer MiB | Max op ms | Total ms | Avg main KiB | Avg thumb KiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| single-jpeg-small-landscape | B | 1 | 1/1 | 91.5 | 11.6 | 4.3 | 1.7 | 216 | 218 | 72.9 | 2.1 |
| single-jpeg-typical-landscape | B | 1 | 1/1 | 129.2 | 11.2 | 12.7 | 10.0 | 622 | 626 | 210.7 | 1.6 |
| single-jpeg-typical-portrait | B | 1 | 1/1 | 120.9 | 11.3 | 12.7 | 10.0 | 621 | 625 | 209.5 | 1.5 |
| single-jpeg-near-limit | B | 1 | 1/1 | 130.2 | 11.1 | 31.8 | 28.8 | 820 | 835 | 473.0 | 1.5 |
| single-png-typical-landscape | B | 1 | 1/1 | 111.8 | 11.3 | 18.8 | 16.1 | 557 | 566 | 214.5 | 1.7 |
| single-png-rgba-portrait | B | 1 | 1/1 | 177.3 | 11.3 | 24.9 | 21.0 | 1058 | 1075 | 1309.3 | 48.0 |
| single-png-near-limit | S | 1 | 1/1 | 131.7 | 11.4 | 33.3 | 29.8 | 760 | 778 | 959.6 | 2.4 |
| single-webp-typical-portrait | B | 1 | 1/1 | 121.7 | 11.3 | 8.6 | 5.8 | 707 | 710 | 272.6 | 1.4 |
| single-webp-near-limit | B | 1 | 1/1 | 145.3 | 11.1 | 32.4 | 29.3 | 2396 | 2412 | 612.7 | 1.5 |
| single-jpeg-stress-64mp | B | 1 | 1/1 | 126.9 | 11.3 | 4.7 | 2.2 | 496 | 498 | 7.0 | 0.4 |
| single-png-stress-144mp | B | 1 | 1/1 | 201.2 | 11.3 | 9.1 | 6.6 | 1277 | 1280 | 7.0 | 0.4 |
| single-png-over-pixel-limit | B | 1 | 0/1 | 85.6 | 11.2 | 7.6 | 5.1 | 10 | 13 | - | - |
| single-invalid-random-bytes | B | 1 | 0/1 | 82.1 | 11.1 | 4.5 | 2.0 | 4 | 5 | - | - |
| single-invalid-truncated-jpeg | B | 1 | 0/1 | 122.2 | 11.4 | 6.9 | 4.4 | 103 | 105 | - | - |
| single-invalid-text-as-png | B | 1 | 0/1 | 81.5 | 11.2 | 4.0 | 1.5 | 4 | 6 | - | - |
| single-invalid-empty | B | 1 | 0/1 | 81.7 | 11.2 | 4.0 | 1.5 | 2 | 3 | - | - |
| single-invalid-oversize | B | 1 | 0/1 | 91.5 | 11.1 | 14.0 | 11.5 | 1 | 17 | - | - |
| single-invalid-gif-mime | B | 1 | 0/1 | 86.6 | 11.2 | 9.0 | 6.5 | 0 | 5 | - | - |
| single-mime-mismatch-png-as-jpeg | B | 1 | 1/1 | 108.7 | 11.1 | 18.8 | 16.1 | 399 | 404 | 214.5 | 1.7 |
| sequential-12-mixed | B | 1 | 12/12 | 187.2 | 11.3 | 42.2 | 39.2 | 1465 | 9757 | 448.3 | 9.3 |
| sequential-12-near-limit | S | 1 | 12/12 | 144.3 | 11.5 | 42.6 | 39.2 | 2884 | 18338 | 681.8 | 1.8 |
| concurrent-1-jpeg-near-limit | B | 1 | 8/8 | 159.0 | 11.0 | 59.9 | 56.5 | 1031 | 6839 | 473.0 | 1.5 |
| concurrent-2-jpeg-near-limit | B | 2 | 8/8 | 180.1 | 11.1 | 59.9 | 56.5 | 1282 | 4396 | 473.0 | 1.5 |
| concurrent-4-jpeg-near-limit | B | 4 | 8/8 | 269.5 | 11.1 | 125.4 | 121.0 | 1648 | 3332 | 473.0 | 1.5 |
| concurrent-1-png-near-limit | S | 1 | 8/8 | 138.7 | 11.3 | 52.4 | 49.0 | 942 | 6749 | 959.6 | 2.4 |
| concurrent-2-png-near-limit | S | 2 | 8/8 | 185.9 | 11.2 | 62.9 | 58.5 | 1319 | 4246 | 959.6 | 2.4 |
| concurrent-4-png-near-limit | S | 4 | 8/8 | 288.8 | 11.2 | 122.1 | 115.9 | 1461 | 3019 | 959.6 | 2.4 |
| concurrent-1-mixed | B | 1 | 12/12 | 196.0 | 11.3 | 42.2 | 39.2 | 916 | 8554 | 448.3 | 9.3 |
| concurrent-2-mixed | B | 2 | 12/12 | 237.4 | 11.2 | 49.7 | 45.4 | 1039 | 5181 | 448.3 | 9.3 |
| concurrent-4-mixed | B | 4 | 12/12 | 256.7 | 11.5 | 67.3 | 64.4 | 1703 | 4399 | 448.3 | 9.3 |
| concurrent-4-png-stress-144mp | B | 4 | 4/4 | 555.4 | 11.3 | 25.6 | 23.1 | 3444 | 3456 | 7.0 | 0.4 |
| deterministic-jpeg-near-limit | B | 1 | 4/4 | 140.6 | 11.1 | 50.2 | 47.3 | 1269 | 4533 | 473.0 | 1.5 |
| deterministic-retry-jpeg-near-limit | B | 1 | 4/4 | 141.1 | 11.1 | 50.7 | 47.7 | 945 | 3446 | 473.0 | 1.5 |
| variant-concurrent-4-jpeg-near-limit-sharp-concurrency-1 | B | 4 | 8/8 | 248.9 | 11.2 | 116.2 | 111.8 | 1585 | 3023 | 473.0 | 1.5 |
| variant-concurrent-4-jpeg-near-limit-sharp-cache-off | B | 4 | 8/8 | 272.4 | 11.1 | 116.2 | 111.8 | 1565 | 3306 | 473.0 | 1.5 |

## Memory, concurrency and disk findings

- Highest process peak: **582,385,664 bytes / 555.4 MiB**, four concurrent 144 MP PNGs. The same
  workload's sampled heap was 11.3 MiB, external 25.6 MiB and ArrayBuffer 23.1 MiB. Its inputs
  were only 1.83 MiB each and outputs about 7 KiB + 0.4 KiB. Encoded file-size/output caps alone
  do not bound this decoded/native workload. A single 144 MP PNG peaked at 201.2 MiB.
- Across effective scenarios, maximum sampled heap was **11.6 MiB**, external **125.4 MiB** and
  ArrayBuffer **121.0 MiB**. These maxima occur at different instants/scenarios; external includes
  ArrayBuffer memory and must not be added to it. Do not sum these peaks to estimate RSS.
- JPEG near-limit peaks for 1/2/4 in flight: **159.0 / 180.1 / 269.5 MiB**. Eight operations took
  6839 / 4396 / 3332 ms. PNG: **138.7 / 185.9 / 288.8 MiB**, 6749 / 4246 / 3019 ms. Throughput
  improved while memory and maximum per-operation latency generally rose.
- Mixed 1/2/4 peaks: **196.0 / 237.4 / 256.7 MiB**. Twelve sequential mixed operations peaked at
  187.2 MiB; twelve sequential near-limit operations peaked at 144.3 MiB. These short runs are
  not evidence of indefinite memory stability or absence of leaks.
- With four JPEGs in flight, Sharp concurrency=1 measured 248.9 MiB versus baseline 269.5 MiB;
  cache disabled measured 272.4 MiB. These isolated variants do not establish a universal
  reduction. Sharp thread concurrency is not a limit on the number of active transforms.
- Large RSS with a small JavaScript heap is consistent with substantial native/process memory
  costs. Full input Buffers and retained outputs also contribute. No native allocation profiler
  was used; exact causal attribution to codecs, cache or allocator retention is not established.
- Successful outputs accumulated only within each disposable scenario, as expected, then were
  removed. There were no unexpected temp leftovers in completed measurements. The runner does
  not measure disk high-water bytes, write throughput, multipart aborts, ENOSPC or hard-kill
  orphan cleanup. Retained synthetic inputs are an intentional audit archive, not leftovers.
- P2-4a recovery disk usage is separate from transform memory and was not changed or duplicated.

## Limits and the 512-MiB API instance

The **555.4 MiB** isolated process peak exceeds 512 MiB before accounting for a full API's other
activity. It is evidence of a hazardous synthetic case and a reason to restrict accepted pixels
and concurrent transforms. It is **not** a verified Linux/container failure threshold or proof of
historical production OOM causation. No production metrics/logs or live configuration were read.

Windows allocator/working-set behaviour, CPU, Sharp platform build and desktop contention differ
from Render. The worker omits the full Express app, DB/background jobs, actual multipart parsing,
socket queues and simultaneous users. Timing and sampled peaks have no repeated-trial confidence
intervals. The 5-ms sampler may miss shorter spikes and can be delayed by scheduling; maxRSS covers
whole child lifetime, including startup/imports. Baseline subtraction is descriptive, not isolated
Sharp allocation accounting. Fixture generation runs in the parent and is outside child metrics.
Synthetic flat images do not represent all real compression patterns. Local quick regression
tests are tooling checks, not additional capacity measurements.

## Reproduce without production access

From repository root, use the direct Node command on Windows to avoid npm/cmd interpreting regex
alternation as shell pipes. Output and optional retained-fixture directories are local paths.
Retained-fixture directories must be new; existing directories are rejected rather than overwritten.
Run only one benchmark invocation at a time; inspect running processes first.

```powershell
# Full corrected 35-scenario matrix (expensive; only on an approved offline development host):
node --import tsx apps/api/src/scripts/runPhotoMemoryBenchmark.ts --profile full --out ./p2-1-results.local --preserve-fixtures ./p2-1-fixtures.local

# Actual supplemental selection (new paths required for another run):
node --import tsx apps/api/src/scripts/runPhotoMemoryBenchmark.ts --profile full --only '^(single-png-near-limit|sequential-12-near-limit|concurrent-[124]-png-near-limit)$' --out ./p2-1-results.local --preserve-fixtures ./p2-1-fixtures.local

# Small tooling regression suite:
npm.cmd run test -w apps/api -- tests/photoMemoryBenchmark.test.ts
```

The selector limits scenario execution; fixture generation still creates the full profile.
The default runner removes disposable work roots on completion/failure and emits JSON/Markdown.
`--preserve-fixtures` retains inputs separately. Process termination can bypass cleanup; there is
no durable per-scenario resume checkpoint, so an interrupted new invocation needs evidence review
before repeating work. Completed measurements were recovered here, so no restart was needed.

## Validation

- PASS: benchmark regression suite, **12/12** tests (deterministic fixtures, actual quick pipeline,
  expected invalid inputs, target/MIME guards, preservation/no-overwrite and timeout cleanup).
- PASS: API source typecheck and API build.
- PASS: separate strict CommonJS TypeScript check of the benchmark test.
- PASS: repository lint with five existing Admin no-img-element warnings; Storefront clean.
  API has no configured lint script.
- PASS: broader photo/outbox/backup/AI-intake regressions, **713/713** tests in **24 files**, using
  `npm.cmd run test -w apps/api -- productPhoto productPhotos aiIntake --hookTimeout 60000`.
  The longer hook timeout avoids the previously observed Windows app-import setup timeouts;
  repository test configuration was not changed. P2-4a's 13 new tests belong to its separate PR
  #376 and are not present on this branch.
- GitHub CI: not yet verified; local evidence does not establish CI acceptance.

## Proposed P2-2 implementation, requiring evidence review and acceptance

Issue #377 remains the implementation gate. No production upload changes are included here.

1. Stage the product-photo multipart input in a dedicated quota-controlled temporary directory,
   after the existing authentication/permission checks, with the same 10 MiB and JPEG/PNG/WebP
   contract. Pass a staged path/stream to Sharp without reading the whole file back into a Buffer.
   Preserve the current Buffer interface for deterministic AI-intake finalization initially.
2. Bound simultaneous transforms with a process-wide admission limit and a finite waiting queue
   or explicit overload rejection. Apply admission before unbounded request/body accumulation;
   account separately for staged disk and concurrent multipart requests. Sharp thread settings
   alone are insufficient. Start evaluation with one active transform, then compare two on a
   representative constrained offline host; neither is an approved production setting yet.
3. Enforce a decoded-pixel limit in the actual Sharp constructor, not only metadata checks after
   decode. This matrix includes accepted 24 MP and stress 64/144 MP inputs but does not establish
   a business-compatible final limit. Test intermediate dimensions and representative photos;
   accept a concrete pixel/concurrency guardrail before implementation/cutover.
4. Write unique main/thumbnail staging targets, verify output contracts, and preserve canonical
   IDs/order/primary/alt text and outbox transitions. Preserve deterministic destination keys,
   idempotent retries and collision protection. Never overwrite/delete pre-existing originals
   during failure compensation. Backup ownership and eBay/Noctella Web readiness stay unchanged.
5. Cover success, abort, malformed multipart, decode errors, disk-full, interrupted writes,
   overlapping uploads and cleanup failure. Clean staged inputs and partial outputs in finally;
   define safe crash-orphan retention/sweep rules separately from canonical photo cleanup.
6. Compare the same fixtures before/after on representative hardware with an explicit memory
   cap and full application baseline. Record RSS, heap/external, latency, staged disk usage and
   rejection/backpressure behaviour under 1/2/4 in-flight and 10+ sequential workloads. Run
   photo, AI-intake, outbox, backup/recovery and marketplace readiness regressions and CI.

Remaining gates: owner review of this evidence, accepted pixel/admission/disk budgets, constrained
host verification, and explicit authorization for the separate P2-2 runtime PR. No primary-storage
cutover, S3 access, Render changes, credentials, listing publication, merge or deployment is proposed
as part of P2-1. Rollback of this PR is removal/revert of offline tooling and docs; no runtime,
database, infrastructure or photo-data rollback is required.
