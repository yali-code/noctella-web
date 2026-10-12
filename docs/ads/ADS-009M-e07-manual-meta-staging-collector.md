# ADS-009M — Manual Meta-only E07 staging operator command

Date: 2026-10-12 · Tracking: #335 · Staging-only, no scheduler or HTTP endpoint.

## Design and execution boundaries

`npm run ads:meta:e07 -w apps/api` invokes `runMetaE07Staging`.
The default `NOCTELLA_E07_OPERATION=preflight` does **not** open ERP SQLite or call Meta;
it first validates explicit staging scope, requires an R2 backup key,
and downloads the **staging R2 backup into an isolated temporary workspace**
to check the expected prefix, byte size, SHA-256, SQLite integrity and <=36-hour freshness.

`NOCTELLA_E07_OPERATION=preview` performs the same backup gate **before** read-only Meta campaign Insights;
it requires a separate Meta paid access token. It does not initialize ERP SQLite or write snapshots.

`NOCTELLA_E07_OPERATION=write` is disabled unless the separate **per-invocation**
`NOCTELLA_E07_ONE_TIME_WRITE_ACK=I_AUTHORIZE_ONE_TIME_STAGING_SNAPSHOT_WRITE` is supplied.
The ordinary preview and staged scope acknowledgments remain required.
Only after backup verification, provider account identity/EUR/timezone validation,
completed account-local reporting days, matching campaign/source provenance
and nonempty real metrics does the command dynamically import the SQLite runtime.
At that point it calls the existing checked/idempotent paid evidence store.

**No campaign is currently present**, so production-like E07 write/replay is **NOT RUN / NOT ACCEPTED**.
A missing Meta report is never mapped to zero spend or stored as a completed run.
A preview or test using injected fakes is not proof of a real provider observation.

Never save the per-invocation write acknowledgement as a permanent Render environment variable.
Do not run this command in production. Staging disk isolation and Cloudflare R2
bucket-scope are prerequisite operator checks; an environment variable's name is
not cryptographic proof of service or bucket isolation.

## Tests

Unit tests use injected backup checker, Meta client and persistence callback, with **no R2
network request, no Meta request and no live SQLite access**. They assert that:
- Default preflight does not make Meta or database calls.
- Missing one-time write authorization fails before any R2/provider/database call.
- Backup verification failure stops provider contact and persistence.
- Preview returns sanitized metrics but never opens SQLite.
- Missing campaign report returns `NO_CAMPAIGN_REPORT`, not synthetic zero rows.
- Provider identity conflicts and incomplete Meta-local days are rejected.
- Only a fully gated synthetic observation may reach an injected persistence callback.

Full E07 operational acceptance still needs a completed real Meta campaign report,
actual staging backup evidence, on-disk snapshot count before/after, idempotent
replay, conflict checks and a sanitized #335 operator audit. Separately finalized
billing (E09) and trustworthy marketplace attribution (E11) are NOT claimed.

## Non-goals

No Render manual deploy, production activation, budget/campaign modification,
paid advertising spend, new API route, scheduler, Web UI, new migration, new
marketplace ROAS attribution, Google Ads or Pinterest pilot.
