# Gate 5 exact-head CI record

Candidate: `486639e755dca2e1c29c6530e6133f3a07094b89`.
Run: https://github.com/yali-code/noctella-web/actions/runs/39659880724
Existing artifact `12372843041` was downloaded and inspected; no tests were rerun.

109 cases: 66 passed, 43 skipped, 0 failed. Five files passed.
All skipped cases below are PostgreSQL-only or PostgreSQL-configuration sentinels.
No PostgreSQL database acceptance is claimed.

## Verbatim skipped-case names

- `4C authorized W8 deletion on postgres the public entry point deletes on SQLite and retains on PostgreSQL (unserialized order snapshots)` (skipped)
- `4C authorized W8 deletion on postgres deletes exactly the committed, unreferenced recorded copies; evidence rows and other files stay; replay is idempotent` (skipped)
- `4C authorized W8 deletion on postgres a partially completed earlier deletion finishes only the remaining verified name` (skipped)
- `4C authorized W8 deletion on postgres canonical deletion preserves private derivatives and exact publication anchors; replay removes zero` (skipped)
- `4C authorized W8 deletion on postgres unknown or unresolved ownership retains both files` (skipped)
- `4C authorized W8 deletion on postgres a current photo row or media reference retains both files` (skipped)
- `4C authorized W8 deletion on postgres a foreign or changed file at either key retains both names` (skipped)
- `4C authorized W8 deletion on postgres eligibility is read under the operation row lock: a concurrent state change wins` (skipped)
- `PostgreSQL acceptance is configured` (skipped)
- `W2 fenced owner on postgres a stale generation can neither commit nor overwrite the new owner's files` (skipped)
- `W2 fenced owner on postgres a crash after publication keeps the evidence, is reported, and a retry recovers exactly once` (skipped)
- `W2 fenced owner on postgres a lost commit acknowledgement does not duplicate the photo on retry` (skipped)
- `W2 fenced owner on postgres concurrent duplicates of one identity produce exactly one photo` (skipped)
- `W2 fenced owner on postgres a different file at the canonical key is never overwritten: the operation goes to review, nothing commits` (skipped)
- `W2 fenced owner on postgres F3: foreign identical-byte main canonical inode is preserved and rejected` (skipped)
- `W2 fenced owner on postgres F3: foreign identical-byte thumb canonical inode is preserved and rejected` (skipped)
- `W2 fenced owner on postgres F3: a missing private name is never linked; recovery adopts only the recorded copy inode` (skipped)
- `W2 fenced owner on postgres F3: a replaced private name is never linked; recovery adopts only the recorded copy inode` (skipped)
- `W2 fenced owner on postgres F2 REMEDIATED: stale W2 A cannot create a canonical name while reclaimed B is sealed but has not published` (skipped)
- `W2 fenced owner on postgres NEGATIVE CONTROL: the legacy publishSealedArtifacts primitive still lets stale A link before B` (skipped)
- `W2 fenced owner on postgres private generation evidence never lives under the public static root` (skipped)
- `W2 fenced owner on postgres SIMULATED remount W2 recovery at intent` (skipped)
- `W2 fenced owner on postgres SIMULATED remount W2 recovery at main` (skipped)
- `W2 fenced owner on postgres SIMULATED remount W2 recovery at thumb` (skipped)
- `W2 fenced owner on postgres SIMULATED remount W2 recovery at commit` (skipped)
- `PostgreSQL acceptance is configured` (skipped)
- `fenced W2 + W4 on postgres finalization commits exactly one fenced operation, photo and outbox event per staged photo, and finalizes the intake` (skipped)
- `fenced W2 + W4 on postgres a retry after a lost acknowledgement is idempotent: no new operations, photos, events or files` (skipped)
- `fenced W2 + W4 on postgres a crash after canonical publication commits nothing, keeps evidence, and a retry finalizes exactly once by adopting the recorded copies` (skipped)
- `fenced W2 + W4 on postgres a Product that already has photos is refused before any intent, operation or canonical copy is created` (skipped)
- `fenced W2 + W4 on postgres a crash after sealing (before publication) publishes nothing and recovers exactly once` (skipped)
- `fenced W2 + W4 on postgres an expired lease cannot hand an actively publishing finalization to another finalizer; no duplicate effects` (skipped)
- `fenced W2 + W4 on postgres F2 REMEDIATED (W4): a stale finalizer superseded before T1 never creates a canonical name` (skipped)
- `fenced W2 + W4 on postgres F3: W4 rejects foreign identical-byte main canonical inode without finalizing` (skipped)
- `fenced W2 + W4 on postgres F3: W4 rejects foreign identical-byte thumb canonical inode without finalizing` (skipped)
- `fenced W2 + W4 on postgres a changed staged source never reuses an existing operation (409, nothing committed)` (skipped)
- `fenced W2 + W4 on postgres concurrent finalizations of one intake produce exactly one set of effects` (skipped)
- `fenced W2 + W4 on postgres #458: with no explicit driver, W2 and W4 route from DATABASE_DRIVER (incl. supabase-postgres) and commit` (skipped)
- `fenced W2 + W4 on postgres W2 and W4 share one authority: both crashes are reported together and both recover` (skipped)
- `fenced W2 + W4 on postgres SIMULATED remount W4 recovery at intent` (skipped)
- `fenced W2 + W4 on postgres SIMULATED remount W4 recovery at main` (skipped)
- `fenced W2 + W4 on postgres SIMULATED remount W4 recovery at thumb` (skipped)
- `fenced W2 + W4 on postgres SIMULATED remount W4 recovery at commit` (skipped)


See [production package](../release/GATE5_PRODUCTION_RELEASE_PACKAGE.md) for artifact hashes,
supported-platform evidence, production prerequisites and rollback constraints.
Final reviews: Claude PASS and Copilot PASS, supplied by the owner during the
subsequent readiness consolidation for runtime candidate
`486639e755dca2e1c29c6530e6133f3a07094b89` / PR #496. This records owner
attribution; raw review links/embedded SHA attestations were not supplied or
independently fetched. No claim that later documentation was reviewed by them.
Production acceptance remains PENDING; entire Photo Stage 5 is not closed.
