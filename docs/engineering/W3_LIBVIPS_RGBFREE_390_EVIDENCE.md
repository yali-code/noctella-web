# #390 W3 libvips RGB-free experiment: evidence and remaining-peak diagnosis

Source: CI run 38702950059 (PR #416, head `efe3d73`, profile `native-rgbfree`), artifact
`photo-upload-linux-38702950059-1` (14-day retention; figures copied here). DIAGNOSTIC ONLY, not acceptance.

## Measured (unchanged 24 MP workload, 8 operations, 512 MiB, no swap, 1 CPU)

| Case | libvips mapped (verified via /proc/self/maps) | Allocator env | cgroup peak | OOM / max events | Ops | Parity vs reference |
| --- | --- | --- | --- | --- | --- | --- |
| reference | npm prebuilt | glibc arena1+mmap | 461.52 MiB | 0 / 0 | 8/8 | reference |
| unmodified | rebuilt, unpatched | default glibc | 512.00 MiB | 1 OOM kill / 120 | 0 | MISSING (killed) |
| patched | rebuilt + RGB-free | default glibc | 512.00 MiB | 0 / 29 (reclaim at limit) | 8/8 | MATCH |
| unmodified-arena1 | rebuilt, unpatched | glibc arena1+mmap | 476.37 MiB | 0 / 0 | 8/8 | MATCH |
| patched-arena1 | rebuilt + RGB-free | glibc arena1+mmap | 411.43 MiB | 0 / 0 | 8/8 | MATCH |

- Same-build effect of the patch: 476.37 -> 411.43 MiB (-64.94 MiB). Gate 384 MiB: FAIL by 27.43 MiB.
- Run-to-run noise: the prebuilt reference measured 461.52 MiB here and 483.13 MiB in the earlier allocator run.
- Parity: the 11 outputs (2 W3 intake WebPs 10,463,844 B; W4 finalized main 492,256 B + thumb 1,490 B;
  3 product uploads 484,350 B + thumbs 1,516 B; Instagram JPEG 101,579 B) have identical SHA-256 multisets.
- Integrity: every completed case passed the scenario's row/outbox/admission assertions
  (rows 4, outbox 4, AI rows 2, native peak 1 / 24 calls, admission held 0) and cleanup (9/9 files, no temp files).
- Native safety: valgrind 3.19.0 memcheck, 0 errors for both variants. RGB, RGBA, smart-subsample, lossless,
  target_size and 4-frame animation outputs are byte-identical across unmodified/patched, native/valgrind.
- Provenance: sharp-libvips `20b5e899` (v1.2.4), vips tarball `41e9a143...`, patch `fb806bd9...`,
  cargo-c 0.10.16 (`17d43178...`), GCC 10.5.0, meson 1.11.2, built libs unmodified `6782916b...`,
  patched `52de889a...`. NOT verified: build base image digest (not recorded), Rust nightly unpinned
  (`1.101.0-nightly 2026-10-14`, differs from the toolchain that built the npm binary).

## Where the remaining peak is (patched-arena1, second W3 encode in ai.upload.wave1)

50 ms cgroup samples: 167 MiB before the encode -> 270 MiB while the 72 MB RGB frame fills -> 202 MiB right
after import (frame released; the 36 MB YUV420 picture remains) -> linear rise of ~209 MiB over ~3 s to the
411 MiB peak -> linear fall during emission. libwebp 1.6.0 source: method 4 uses the token path
(`use_tokens = rd_opt_level >= RD_OPT_BASIC`), token pages accumulate for the whole single pass and
`VP8EmitTokens` frees them one by one only on the final pass; the YUV planes are one allocation
(`WebPPictureAllocYUVA`) still live at the peak. libvips holds about 1 MiB extra after import.

Peak composition: workload baseline about 167 MiB (anon 124, page cache 35-45, kernel 8) + YUV 34 MiB +
tokens about 209 MiB. The same patched encode during setup (baseline 125.5 MiB) peaked at 379.2 MiB.

## Conclusion

No further output-identical change remains inside libvips. Every remaining byte-identical lever is in libwebp
(a fork, not authorized) or in workload scheduling/storage architecture (owner decision):

1. Original-source staging for W3 (store the validated upload, no full-resolution re-encode): removes the
   ~245 MiB encode transient; changes the W3 stored format and W4 output bytes. Smallest option with real margin.
2. Exclusive admission for the full-resolution W3 encode: the only measured sample is 379.2 MiB, 4.8 MiB under
   the gate and inside run-to-run noise; not sufficient alone.
3. libwebp fork discarding consumed YUV rows during the token pass: at most about 34 MiB, about 7 MiB margin.
