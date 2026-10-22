# W11 fenced Instagram derivative: schema review, production wiring and fencing-ON acceptance (#424)

Status: **review and preparation only.**
- The 0042 schema is a proposal (`docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal`).
- `services/w11FencedInstagramDerivativeOwner.ts` is not imported by production code.
- Live W11 keeps refusing with `PHOTO_OWNERSHIP_FENCING_ENABLED=true`; with fencing OFF it is unchanged.

Owner approval is required before any step in §2.

## A. 0042 schema review (tests: `apps/api/tests/w11Derivative0042SchemaReview.test.ts`, `w11FencedInstagramDerivativeProposal.test.ts`)

| Topic | Finding | Evidence |
| --- | --- | --- |
| Migration order | `main` ends at 0038; Etsy 0039 is unmerged; the photo stack adds 0040/0041. There is no migration ledger: files are idempotent `CREATE … IF NOT EXISTS`, applied in sorted order. 0042 references nothing from 0039/0040/0041, so its order is independent; the number only has to stay unique | applies on an empty SQLite DB and on PostgreSQL migrated only through 0038; re-application is idempotent |
| Compatibility | additive only; no ALTER/DROP/UPDATE; no collision with existing names; not in `schema.sql` or `postgres-migrations` (inactive) | static tests |
| Identity / integrity | unique content-addressed `derivative_key`; `kind` CHECK; 64-character `source_fingerprint`; state CHECK; generation > 0; generation history with PK (operation, generation), UNIQUE (operation, nonce) against ABA, and an FK | constraint tests (SQLite with FKs on, PostgreSQL) |
| Leases / CAS | database time only; reclaim requires an expired lease and the expected generation; seal and commit are CAS on generation/owner/nonce/state/lease (+ seal hash) | proposal suite: stale writer, concurrent duplicates |
| Publication | exclusive generation-private directory; `link()` only; post-link inode/hash check; a foreign or changed file means review, never replacement | proposal suite: TOCTOU, crash after seal/publish |
| Diagnostics (gap fixed) | a committed derivative whose canonical bytes changed or vanished is now refused **and flagged** (`review_reason`) instead of failing silently; `listW11DerivativeOperationsRequiringRecovery` is read-only | schema review suite |
| Rollback (gap fixed) | `DERIVATIVE_ROLLBACK_BLOCKERS_SQL`: drop only when no `preparing` / `sealed` / `review` / flagged rows. Committed derivatives are plain immutable canonical files; dropping the tables loses only their ownership evidence | schema review suite |
| Naming | `photo_derivative_operations`, `photo_derivative_operation_generations`, `idx_photo_derivative_operations_state`: parallel to 0040 and unambiguous | static test |

Residual risks:
- There is no lease renewal; the 5-minute lease is far above the measured W11 render time.
- Retention of uncommitted generation directories needs the same owner decision as W2/W4.

## B. Production wiring (minimal diff; do not apply before approval)

W11 has one derivative and no product-photo or outbox row, so it does **not** use `persistFenced*` or the W2/W4
photo commit fence. Its commit CAS (on its own table) is its only database effect. Approval gate, both required in
the same reviewed PR:

1. The owner approves the 0042 schema. Move the proposal DDL into `apps/api/src/db/schema.sql` and
   `postgres-migrations/0042_photo_derivative_operations.sql`, after confirming numbering against `main`.
2. Change the live writer as below. With the tables missing, the fenced path still fails closed: the claim
   transaction errors, and the caller maps it to the existing retryable `processing` error.

```diff
--- a/apps/api/src/integrations/instagram/mediaPreparation.ts
+++ b/apps/api/src/integrations/instagram/mediaPreparation.ts
@@ async function prepareInstagramImageAssetUnadmitted(
-  // W11: derivatives and temporaries live in the canonical root; with ownership fencing ON they are not adopted.
-  if (photoOwnershipFencingEnabled()) throw new InstagramClientError("processing", true);
+  const fenced = photoOwnershipFencingEnabled();
   try {
     ... (unchanged recipe, origin and source validation, readRegularLocalFile, fingerprint, url) ...
-    let work = inFlight.get(destination);
+    if (fenced) {
+      // Approved 0042: generation-fenced, content-addressed derivative; no temporary in the canonical root.
+      const key = await prepareFencedInstagramDerivative(dbRuntime.db, { sourceKey: filename, source, recipeId });
+      if (key !== derivative) throw invalid();
+      return { url, outputPath: `${prefix}${derivative}`, sourceFingerprint: hash, recipeVersion: recipeId };
+    }
+    let work = inFlight.get(destination);
```

- `inspectPreparedInstagramImage` is unchanged: the key, URL and recipe are identical.
- `W11OperationRefusedError` (in progress, review, fence lost) maps to the existing `processing` (retryable) or
  `invalid_media` errors, so the caller contract is unchanged.
- Tests to add in that PR:
  - the live writer with fencing ON on SQLite and PostgreSQL;
  - fencing OFF byte-identical (the existing 29 W11 tests);
  - the wiring gate flipping `w11LiveStillRefusesUnderFencing` to a positive check.

## C. Fencing-ON 24 MP acceptance (prepared, blocked)

- **Profile `combined-fencing-on`:** the unchanged 8-operation 24 MP workload, 3 fresh 512 MiB cgroups. It enables
  `PHOTO_OWNERSHIP_FENCING_ENABLED` and the original-source W3 writer. Its scenario names
  (`linux-combined-fencing-on-t1..3`) are distinct from the fencing-OFF profiles.
- **Probe evidence:** `fencing-on.operations` requires 3 committed `product_upload` and 1 committed `ai_finalize`
  operations, with nothing unfinished.
- **Blocked:** `FENCING_ON_ACCEPTANCE.blocked` stays true until W11 is adopted. `run-host` then records
  `status: BLOCKED` with the reason and zero cases, and exits with code 3. CI asserts exactly this (dry run), so no
  fencing-OFF data can stand in for it.
- **After W11 adoption:**
  - set `blocked: false`;
  - extend the probe assertion with 1 committed `instagram_derivative`;
  - add `combined-fencing-on` to the Linux CI matrix.

  Pass means each trial at or under 384 MiB, 8/8 operations, zero OOM or memory-limit events, and the integrity and
  fencing assertions passing at the exact SHA.

## Owner decisions

1. Approve or amend the 0042 schema and its numbering, alongside resolving 0039/0040/0041 ordering on `main`.
2. Retention of uncommitted generation directories (W2/W4/W11).
3. The remaining #424 release decisions:
   - admin `Idempotency-Key`;
   - fixed tenant scope;
   - raw-original retention and backups;
   - Render drain;
   - staging and rollback;
   - release authorization.
