# ADS-009 — Staging-only acceptance checklist (not executed)

This checklist is for owner-authorized **staging** validation of the Ads Agent stack, Phases 6–9. Nothing here has been run. Do not deploy to production. Do not create, change or fund campaigns.

## 0. Preconditions (owner)
- [ ] Explicit approval to deploy the integrated Draft stack to **staging only** (`noctella-staging-api` and Admin).
- [ ] Staging uses its **own** SQLite file. Take a backup before deploying and confirm restore works. Never point staging at `/var/data/noctella.sqlite` or production R2 backups.
- [ ] No schema migration is expected: Phases 6–9 add no tables, and paid evidence goes only to `analytics_runs` / `analytics_metric_snapshots`. Confirm that `ensureSchema` reports no new `ads*`/`paid*` tables.

## 1. Environment (names only; values are never written to GitHub, logs or chat)
| Variable | Purpose |
|---|---|
| `NOCTELLA_META_AD_ACCOUNT_ID`, `NOCTELLA_META_AD_ACCESS_TOKEN` | Dedicated Meta Ads system-user token with `ads_read` (not the organic Instagram token) |
| `NOCTELLA_GOOGLE_ADS_CUSTOMER_ID`, `NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN`, `NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN`, optional `NOCTELLA_GOOGLE_ADS_MANAGER_CUSTOMER_ID` | Google Ads read-only (blocked until the account and developer token exist) |
| `NOCTELLA_PINTEREST_AD_ACCOUNT_ID`, `NOCTELLA_PINTEREST_AD_ACCESS_TOKEN` | Pinterest Ads read-only, separate from social analytics OAuth (blocked) |
| `NOCTELLA_PAID_ADS_PREVIEW_ACK=I_AUTHORIZE_PAID_READ_ONLY` | Per-command read acknowledgement. Set it only for the duration of an approved check, then remove it. |

## 2. Meta account and time zone (read-only, owner-run)
- [ ] Run `npm run ads:meta:verify -w apps/api` inside staging. Expect `accountAccess: VERIFIED`, `currency: EUR`, a **non-empty `reportingTimeZone`**, and `reportRows ≥ 0`.
- [ ] Record the time zone in #335. Every paid window and billing period must use this zone's local days.
- [ ] Failure classes are printed without secrets: `authentication` usually means the 60-day token has expired; `permission` means `ads_read` or the account role is missing; `rate_limit` means retry later, manually.

## 3. Reporting-period availability
- [ ] A Meta campaign with real delivery exists, owner-created in the Meta UI and never by this system.
- [ ] Pick a **completed** window (all local days ended) of at most 31 days.
- [ ] Run `npm run ads:paid:preview -w apps/api` with provider, campaign and dates set via the `NOCTELLA_PAID_ADS_*` variables. This is read-only and writes nothing to the database. Check: identity matches, EUR, account-local window, and `NO_CAMPAIGN_REPORT` for empty data (not zero).

## 4. Read-only collector approval boundary
- [ ] **Engineering gap:** there is no command yet for an approved **write** collection into staging SQLite. `collectPaidCampaignEvidence` requires `explicitSnapshotWriteApproval`, which only code can supply today. A small owner-approved staging command with its own acknowledgement and backup step is needed before checks 5–6 can use real windows.
- [ ] Once it exists: collect, then replay the same window (expect `replayed: true` and no new rows). A later restatement must stop with `PAID_PROVIDER_RESTATEMENT`.

## 5. Admin authentication smoke test (staging)
- [ ] Without a session, `/api/analytics/ads/performance/meta/<id>`, `/ads/intelligence/...`, `/ads/providers/readiness` and `/ads/campaign-draft/...` all return 401. An Admin without `analytics.view` gets 403.
- [ ] Owner, Marketing page:
  - readiness shows "connection verified: NO" and "spending: DISABLED";
  - the paid report shows `NOT_COLLECTED` before collection;
  - Intelligence shows `NOT_COLLECTED`, or windows with Unknown where data is missing;
  - the draft preview shows "Draft approval: Not recorded" and "Execution authorization: Disabled", with no approve or launch button.
- [ ] POST/PUT/PATCH/DELETE on these paths return 404. Responses are `Cache-Control: no-store` and never contain token values.

## 6. Billing reconciliation (needs real evidence)
- [ ] A finalized Meta billing statement for the same account, campaign and **account-local** period, with ad spend only (tax and fees separated), obtained through an owner-approved channel.
- [ ] Expect `RECONCILED_FOR_REVIEW` only on an exact match within €0.01. Unsettled billing gives `UNSETTLED`. A period in UTC days gives `SCOPE_MISMATCH`. Never treat reporting-API spend as billing.

## 7. Provider error scenarios (to observe or confirm)
- [ ] Expired token: `authentication`, nothing stored.
- [ ] Throttling: `rate_limit`, no automatic retry loop.
- [ ] Wrong account or currency: rejected before metrics are requested.
- [ ] Malformed or paginated response: rejected.

## 8. Rollback
- Revert or skip the staging deploy. Restore the pre-deploy staging DB backup if paid rows must be removed.
- Revoke the provider token and remove the staging environment variables.
- See `ADS-006-PHASE6-CLOSEOUT.md` (#342).

## 9. Evidence required before declaring operational readiness
1. The verify output (sanitized), including `reportingTimeZone`.
2. A preview of a real completed window.
3. A stored collection plus replay evidence.
4. The Admin smoke test results.
5. A reconciliation against a finalized statement.
6. Google and Pinterest equivalents, or explicit owner de-scoping.
7. Attribution evidence only if attribution is claimed.

Mocked tests are **not** a substitute for any item here.
