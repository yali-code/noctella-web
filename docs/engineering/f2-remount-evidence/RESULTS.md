# Evidence ledger

Parent exact head32a027dc60b46a35e77352019a6df34e532f1924; baseline source SHA256 f2274ecd4b338843c1443e65c654f6b9d68a46566748bdb1f355ebcc557215dd verified byte-for-byte against Git. The final Draft#492 metadata contains the exact delivery HEAD and completed CI results.

- baseline-exact.txt: exact pinned publisher, same final three positive recovery regressions:3 expected failures /12 intentionally unselected skips; SOURCE_REPLACED rather than PUBLISHED. The final codec requires new evidence; this does not reinterpret old numeric records. Baseline snapshot/test source are committed.
- Initial full regression:11 failures/4 passes, including cascading fixture setup failures because old code cannot publish the new cohort. Retained separately from the precise three-case baseline.
- codec-final.txt:23 passed/1 Linux-native skip (Windows).
- local-final-provenance.txt:60 passed/39 explicit PostgreSQL/Linux skips across four scoped suites.
- final-resource-boundary.txt:38 passed/17 PG skips across three suites at that revision.
- Corrected synthetic-evidence run:54 passed/34 PG/Linux skips.
- API typecheck passed after fixing a local shared-package resolution issue; the initial errors/logs are retained. No parent dependencies or source were rebuilt/modified. Own worktree dependency links point shared compilation to this checkout.
- Writer census/disposition:7 passed.
- The local evidence-output failure was a stat mock not handling a nonexistent copy destination; corrected. Initial source-pin/preflight expectation failures and a local5s SQLite compatibility timeout are retained; production compatibility assertions were not weakened. Candidate source pin and new manual preflight check were updated deliberately.

Raw Windows transcripts are original PowerShell output. simulated-evidence.zip includes tiny synthetic source/copy/canonical bytes, hashes/inodes/sizes, positive/negative snapshots and W2/W4 DB/outbox/epoch results with mocked kernel observations. No real remount or Render acceptance is claimed. Native descriptor UUID, actual process-death/live-executor refusal, real PostgreSQL and full regressions require the exact-head Linux CI.

Final CI artifact photo-persistent-remount retains native and simulated snapshots. Full results and run URLs will be recorded in Draft#492 after completion. Raw CI archives/logs will additionally be downloaded and hash-verified into a task-specific preserved local evidence directory; no source/parent mutation is needed to retain them.

New-version failed/replaced/ambiguous staging copies are retained until a valid T2 cleanup, which can increase disk residency across repeated failures. This task does not add a scavenger, change disk quotas, enable flags or claim disk/resource acceptance. Legacy controls preserve their original cleanup behavior; only a failed current-attempt partial copy may be removed by that attempt.
