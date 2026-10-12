# ADS-009J — Meta-only pilot E07 staging collection gate

Date: 2026-10-12. Scope: design and acceptance criteria, **not runtime authorization**.
Tracking: #335. Baseline: main `4982301ea25fc0ae8014c4cd1bb4d6e7a455eac8`.

## Status

E05 operator-attested Meta paid account access PASS (EUR, `Europe/Sofia`). E06 BLOCKED: the account is new and has no real paid campaigns. E07 runtime collection and replay NOT RUN. E12 isolated staging backup-copy recovery PASS; this does not authorize live database replacement. Google and Pinterest Ads are deferred outside the first Meta-only pilot.

## Required engineering boundary for any future E07 CLI

Implement a **manual, staging-only**, server-side command calling `collectPaidCampaignEvidence`. No scheduler, public API route, Admin button, payment or campaign mutation. An E05 account-only verification or E06 read-only preview must **never** implicitly enable collection.

A future write invocation must fail closed **before opening SQLite or contacting Meta** unless all checks pass:

1. Exact runtime identity `RENDER_SERVICE_NAME=noctella-staging-api`, expected staging Render service ID `srv-d9lnbg710e5c73e1qng0` if observable, and `DATABASE_DRIVER=sqlite`. Reject missing or ambiguous environment markers.
2. Live database target must be the designated staging service's isolated `/var/data/noctella.sqlite`. Never accept a user-supplied path or production disk; verify staging disk identity via trusted operator attestation, not mere path equality.
3. Explicit **separate** per-command `NOCTELLA_PAID_ADS_READ_ACK` and `NOCTELLA_PAID_ADS_STAGE_WRITE_ACK`, plus a human-supplied one-time scope (provider `meta`, account, numeric campaign ID, reporting dates). Do not persist an acknowledgement in Render environment; no browser flags.
4. Verify a fresh, staging-only backup and record its sanitized object key, checksum and integrity. Fail closed if backup destination/scoping cannot be independently established.
5. Require valid Meta paid credentials with `ads_read`, EUR account identity and provider-supplied IANA reporting zone. The date range must be completed account-local days, at most 31 inclusive days. Never create/fund a campaign to generate acceptance evidence.
6. Default to `PREVIEW_ONLY`; make snapshot-write an explicit opt-in solely after scope and backup checks. Never write if provider reports no campaign row or all metrics are unknown.
7. Write only to existing staging `analytics_runs` and `analytics_metric_snapshots`; no migration, new table, production access, organic attribution or automatic budget control.
8. Replay the same report window and require `replayed:true` and unchanged snapshot count. A provider restatement must reject with `PAID_PROVIDER_RESTATEMENT`; overlapping same-end window must reject with `PAID_WINDOW_END_CONFLICT`.
9. Print sanitized run/status/metric counts only. Never print tokens, provider raw bodies, env values or buyer/customer data. Never treat `0` response rows as zero ad spend.
10. Before marking E07 PASS, record independent operator-attested real staging write/replay evidence in #335. Unit/in-memory test passes are not substitutes.

## Regression tests to require

- No API request or DB open if stage identity or either acknowledgement is absent.
- Production service identity, non-staging database target, wrong provider, wrong account, invalid campaign ID or date is rejected before mutation.
- Missing/failed backup evidence blocks writing.
- Completed `Europe/Sofia` dates handle DST without UTC-day substitution.
- Empty Meta response remains `NOT_COLLECTED`; no zero-filled snapshot.
- Valid in-memory synthetic observation can write and replay idempotently; restatement and window-end collision fail closed.
- Logs contain no tokens, env dumps, raw provider errors or personal data.
- Code does not expose a network write/launch/campaign endpoint.

## Explicit exclusions

This plan does not authorize: Meta provider calls, ads creation, publishing, ad spend, staging SQLite writes, production deploys, live SQLite replacement, cross-environment R2 access, or a new E12 restore. Implementation and tests may be proposed on a separate reviewed PR; operational E07 PASS needs an actual campaign and separate evidence.

## Current gates

| Gate | Status |
|---|---|
| E05 Meta read-only identity/EUR/timezone | PASS (operator-attested) |
| E06 completed real campaign report | BLOCKED — no campaign |
| E07 gated staging write/replay | DESIGN PREPARED; NOT RUN |
| E09 finalized billing match | BLOCKED — no bill |
| E10 Google/Pinterest | DEFERRED outside Meta-only pilot |
| E11 marketplace attribution/ROAS | UNKNOWN / null |
| E12 isolated backup-copy rehearsal | PASS (operator-attested, not live failover) |
