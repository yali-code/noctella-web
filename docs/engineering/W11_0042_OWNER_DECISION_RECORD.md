# Owner decision record: should the proposed 0042 become a real migration? (#424 FAZ A, W11)

**Decision requested from the owner. Nothing here is activated.**
- `docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal` is not in `schema.sql`
  or `postgres-migrations`.
- Live W11 keeps refusing with `PHOTO_OWNERSHIP_FENCING_ENABLED=true`.
- `FENCING_ON_ACCEPTANCE.blocked` stays `true`.

## Inventory (verified 2026-10-16)

| Migration | Where | Content | Interaction with 0042 |
| --- | --- | --- | --- |
| 0001–0038 | `main` (`7df99ba`) | existing schema | none |
| 0039 | Etsy branches only (`feat/etsy-listing-form-parity-phase1`), unmerged | `ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_*` | disjoint objects |
| 0040 | photo stack (#414…#448) | `photo_operations`, generations, artifacts (W2/W4 authority) | none: 0042 has no FK or reference into it |
| 0041 | photo stack | `photo_w2_upload_intents` | none |
| 0042 (proposal) | proposal file only | `photo_derivative_operations`, its generations table, its state index | n/a |

## Independent proofs (CI, SQLite + real PostgreSQL)

- Applies to an empty SQLite DB and to PostgreSQL migrated only through 0038; re-application is idempotent.
- **Inverse order:**
  - SQLite: 0042 first, then the full startup `ensureSchema`, which includes 0040/0041.
  - PostgreSQL: through 0038, then 0042, then the repository's real 0040 and 0041 files.
- Additive only and unregistered; no name collisions with any table.
- Constraints reject bad rows:
  - unique content-addressed key;
  - kind, state and fingerprint-length checks;
  - generation > 0;
  - history primary key;
  - `UNIQUE (operation, nonce)`;
  - the foreign key.
- Owner behaviour: exactly-once preparation, retries, a changed source, a stale generation, crash after seal and
  after publish, a lost commit acknowledgement, a foreign file at the key, concurrent duplicates.
- Diagnostics: committed-but-tampered or missing bytes are flagged (`review_reason`); a read-only operator listing;
  `DERIVATIVE_ROLLBACK_BLOCKERS_SQL`.

## Risks

1. Numbering collisions if `main` advances; there is no ledger, so a reused number is silent. The CI static test
   already fails if a file named `0042*` appears.
2. SQLite startup creates every `schema.sql` table: once 0042 is in `schema.sql`, each deploy creates the two
   tables, even with fencing OFF (the same as 0040/0041 today).
3. Retention: uncommitted W11 generation directories are kept indefinitely (never auto-deleted). The owner must
   set a retention and operator procedure, shared with W2/W4.
4. W11 has no lease renewal; its 5-minute lease is far above the observed render time. Revisit only if recipes
   grow.

## Recommendation

Yes: make 0042 a real additive migration, **only after** the owner:
- confirms the final number against `main` at merge time, after deciding the 0039/0040/0041 order;
- accepts risk 2;
- sets the retention in risk 3.

There is no technical dependency on 0039/0040/0041 ordering.

## Sequencing (each step separately authorized)

1. **Merge order:**
   1. Etsy 0039 (or renumber);
   2. photo 0040 and 0041;
   3. 0042 together with the W11 wiring diff (`docs/engineering/W11_FENCED_WIRING_DESIGN.md` §B) in one
      reviewed PR.

   Then flip `FENCING_ON_ACCEPTANCE.blocked` to false and add `combined-fencing-on` to the Linux matrix.
2. **Before any deploy:** `db:backup` and `photos:backup`, plus `db:restore-verify`.
3. **Staging:**
   1. Deploy with fencing OFF and confirm W11 is unchanged; the empty tables exist.
   2. Enable fencing and run the W2/W4/W11 staging checklist (runbook §3.6).
   3. Run the fencing-ON 24 MP gate below.
   4. Disable fencing.
4. **Rollback:**
   - Fencing OFF returns W11 to the legacy path immediately; committed derivatives are ordinary immutable files.
   - Drop the 0042 tables only if `DERIVATIVE_ROLLBACK_BLOCKERS_SQL` returns no rows.
   - Never delete generation directories or canonical derivatives during rollback.

## Fencing-ON mixed 24 MP gate contract (after approval)

- **Workload:** profile `combined-fencing-on` (scenario names `linux-combined-fencing-on-t1..t3`). The unchanged
  24 MP 8-operation mixed workload, with:
  - W2 uploads;
  - W3 original-source staging;
  - W4 finalization;
  - W11 preparation and inspection;
  - `PHOTO_OWNERSHIP_FENCING_ENABLED=true`.
- **Pass, for each of the 3 fresh trials:**
  - 512 MiB hard cgroup limit, no swap, no network;
  - 8/8 operations;
  - cgroup peak ≤ 384 MiB;
  - zero `oom` / `oom_kill` / `max` events;
  - the probe's integrity, original-source parity and fencing assertions (3 `product_upload` + 1 `ai_finalize` +
    1 `instagram_derivative` committed, nothing unfinished);
  - `summary.status = PASS` at the exact candidate SHA.
- **Until approval:** CI must keep proving `BLOCKED` (exit 3, W11 reason, zero cases, no Docker), and fencing-OFF
  profiles must never be reported as fencing-ON evidence.
