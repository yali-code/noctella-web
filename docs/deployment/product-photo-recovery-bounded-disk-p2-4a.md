# P2-4a: bounded-disk product photo recovery verification

Tracking: #374. Architecture reference: Draft PR #375.
Baseline: origin/main at 7df99bad74c822e13a690f7a3593637794b7b7c8.

## Change and compatibility

Recovery verification now removes each downloaded artifact in a per-artifact finally block.
It verifies the existing download byte count, actual file size and SHA-256 before proceeding.
The next artifact cannot download until cleanup succeeds. Partial or corrupt downloads receive
the same cleanup attempt. Whole-directory cleanup remains a final fallback.

Both artifact and final directory cleanup failures reject with ProductPhotoBackupError;
cleanup errors were previously suppressed at the directory boundary. This intentionally avoids
reporting success while temporary files remain. The successful response is unchanged:
{ manifestKey, verifiedArtifacts, integrity: "ok" }.

Manifest validation, object-key restrictions, metadata checks, 16 MiB caps, repository interfaces,
and the S3 adapter are unchanged. Recovery invokes only head/download; it never uploads,
modifies or deletes remote objects. The backup writer, photo upload/Sharp processing,
photo outbox and AI intake implementations are unchanged.

## Temporary disk evidence

Let M be downloaded manifest bytes, A_i the bytes of artifact i, and N the number of entries.

- Before: peak retained file bytes = M + sum(A_i).
- After: peak retained file bytes <= M + max(A_i); empty manifests retain M only.
- With existing individual 16 MiB caps: file payload storage <= 32 MiB per verification.
  Filesystem allocation, directory metadata and other processes are outside this bound.
- Concurrent verification runs each have their own directory, so aggregate usage still scales
  with concurrent runs. Manifest parsing and in-memory entries are not bounded-memory changes.

The deterministic fake repository records actual temporary file sizes after every download and
asserts that no previous artifact exists before each subsequent download. Empty, four-entry and
1,000-entry manifests assert exact peak retained file bytes M + max(A_i) and at most one artifact.
Synthetic bytes alternate main/thumbnail roles; no real photos or S3 requests are used.

This is a source-level bound supported by local filesystem regression evidence, not a measured
production capacity, latency or disk-usage improvement. No P2-1 benchmark was started.

## Regression coverage and local validation

New suite: 13 tests covering multiple/empty/large manifests, previous-file removal, SHA-256
mismatch, missing object, partial download, download exception, ENOSPC, returned byte-count
mismatch, actual file-size mismatch, per-artifact cleanup failure, final-directory cleanup
failure, repeated verification, and remote immutability.

- Focused backup/recovery run: 60/60 tests passed across two files.
- New suite after CommonJS-compatible setup adjustment: 13/13 passed.
- Broad photo/outbox/AI-intake run: 685 passed; two suites hit their existing 10-second
  beforeAll timeout, leaving 41 tests skipped. Both suites passed on a targeted rerun
  with --hookTimeout 60000: 41/41 tests. All 726 selected regression tests passed across
  the initial run and targeted rerun; the default-timeout broad invocation was not fully green.
- API production source typecheck passed.
- Separate strict CommonJS TypeScript check of the new test passed.
- Repository lint passed: five existing Admin no-img-element warnings; Storefront clean.
  API has no configured lint script.
- git diff --check passed.

Environment: Windows, Node v24.18.0, npm 11.16.0. Dependencies installed independently in
the isolated worktree from the npm cache. No production or provider access.

## Risks and rollback

A permission/locking failure can still leave temporary files if both per-file and directory
cleanup fail. Verification rejects; operator cleanup may be required. Process termination
can bypass finally blocks. This change does not provide a startup orphan sweep or prevent
concurrent verification runs.

Final cleanup failure now rejects even after all checksums passed. Operators must treat this
as failed verification, fix temporary-directory access and retry. Retrying is read-only and
uses a fresh directory.

Rollback is a revert of this scoped commit; no migration or configuration reversal is needed.
Rollback restores cumulative staging usage and suppression of directory cleanup errors.
No merge, deployment, credentials, Render changes or production restore is part of this PR.
