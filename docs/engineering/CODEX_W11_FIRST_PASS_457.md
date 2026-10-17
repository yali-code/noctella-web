# Codex source-first findings (frozen before reading new agent reports)

Reviewed base: `60a45569e19bf11d7af67123509d04d8dea3684b`.

This first pass was derived from implementation and existing tests. No new Claude/Copilot report was consulted. The reviewer necessarily retains context of its own earlier #455 audit. This is AI technical evidence, not human approval.

- F1 HIGH: `photoOperationAuthority.ts:fileProof` still stats and streams separate pathname resolutions. Hash and inode are not descriptor-bound. W11 uses recursive mkdir without ancestor containment verification.
- F2 HIGH: W11 still links after seal without publication-time generation authorization. A stale writer can publish before its commit CAS fails.
- F3 MEDIUM: EEXIST accepts equal bytes without authenticated generation provenance; committed retries compare only hashes.
- F4 MEDIUM: live fencing-ON refusal remains retryable, but fencing-OFF catch maps infrastructure errors to permanent invalid_media. The inactive activation sketch inherits that catch and omits canonicalRoot propagation.
- F5 MEDIUM / insufficient evidence: no file/directory fsync ordering; hook exceptions do not prove power-loss durability.
- C1 routing now explicitly maps postgres/supabase-postgres and rejects unknown drivers. This is independent source observation; parity needs executable evidence.

No activation, schema registration or live writer edit is authorized. Develop disposable evidence tests first. Keep security verdict separate from whether a vulnerability reproduction test passed.

`LOOP.md` and `AGENTS.md` were absent from the exact commit and worktree; use the NOCTELLA LOOP supplied in the mission. No authoritative twelve-stage mapping has been established.
