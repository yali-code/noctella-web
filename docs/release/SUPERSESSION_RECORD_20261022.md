# Supersession record — 22 October 2026

This record supersedes specific earlier statements for current status. It does not edit, delete or re-run earlier
evidence; earlier files remain the historical record at their dates. All times UTC unless marked.

## 1. W4 ICC/colour

- **Technical:** synthetic ICC conversion test PASS (1 targeted test, two profiles × main/thumb), CI run
  `39659880724` at `486639e755dca2e1c29c6530e6133f3a07094b89`. Evidence:
  `docs/engineering/evidence/w4-color/README.md`, `metrics.json`, `comparison.png`.
- **Owner decision:** the owner accepted W4 ICC/colour **within synthetic-evidence scope only**, 22 October 2026
  09:46Z (12:46 Europe/Istanbul), in the owner's project-management chat.
- **Not performed:**
  - no colour check with a real product photo in any environment;
  - no general colour-fidelity, wide-gamut, calibrated-display or Delta-E claim;
  - the RC2 W4 PASS covered retention/replay, not colour.
- **Superseded statements (status only):**
  - `docs/engineering/evidence/w4-color/README.md` line 21 ("W4 ICC/color acceptance remains OPEN for owner review").
  - `docs/release/GATE5_PRODUCTION_ACCEPTANCE_RECORD_20261022.md` line 103 ("W4 ICC/colour visual acceptance OPEN").
  - The same "W4 ICC/color OPEN" statements in `docs/engineering/PHOTO_PROGRAM_LOCAL_HANDOFF.md` lines 130, 166, 188,
    202, 216, 229 and 245, and in `docs/engineering/GATE5_RETENTION_COLD_BACKUP_PROPOSAL.md` line 101.
- **New status:** **synthetic CI PASS + owner-accepted (synthetic scope only); real-photo colour check NOT DONE (open
  follow-up at first real W4 use).**

## 2. Production cron state

- **At Gate 5 acceptance:** all three production crons were suspended:
  - `background-jobs` (`crn-db3447om7kps73cvc8dg`);
  - `database-backup` (`crn-db3447om7kps73cvc8d0`);
  - `product-photo-backup` (`crn-db3447om7kps73cvc8e0`).

  Sources: Gate 5 record line 35 (Render connector, 08:32Z) and line 110 ("State left in place"); P2 cold record
  09:02:59Z.
- **Later change, after acceptance:** after explicit owner chat approval, the owner resumed only the two backup crons:
  - `database-backup` → active, 22 October 09:35:29Z (Render `updatedAt`);
  - `product-photo-backup` → active, 22 October 09:39:15Z.
- **Current state:**
  - `background-jobs` remains **suspended** (verified 22 October about 12:30Z via the Render connector);
  - production API Maintenance Mode remains **ON**;
  - autoDeploy off.
- **Approval evidence:** owner chat only. No earlier repository record exists; this file is the first.
- **Superseded statement:** Gate 5 record line 110 ("three production crons suspended"). It was true at acceptance time
  and is superseded for the current state.
- **First scheduled runs after resume:** `database-backup` 23 October 03:00Z, `product-photo-backup` 23 October 04:30Z.
  Results are not yet known and are to be recorded separately.

## 3. Code identities

- `main` = `f05d04afb012fe535051d9de318dc1c849d2aded` (PR #498; tag `v2.2.0-rc.1`; GitHub pre-release).
- Production API runtime = `486639e755dca2e1c29c6530e6133f3a07094b89` (Render deploy `dep-dbcilqcs728c73f5ga70`,
  21 October 21:15:55Z).
- **These are different SHAs.** `486639e` is an ancestor of `main`. Between them, nothing changed outside `docs/`,
  `apps/api/tests/` and `scripts/photo-writer-adoption/`, except one line in `.github/workflows/photo-master-stage1-4.yml`.
  Correct wording: **the runtime changes accepted in production are integrated into `main`.** Main and production are
  not the same commit.
- Staging runs `f05d04a`. This is **not** a fencing-ON acceptance: the staging Blueprint does not set
  `PHOTO_OWNERSHIP_FENCING_ENABLED`.

## 4. Unchanged

- Gate 5 limited production acceptance PASS (unchanged).
- RC2 whole-root capture BLOCKED.
- W11/0042 blocked; 4B parked.
- PostgreSQL acceptance not claimed.
- Overall 5/12; normal use not resumed.
