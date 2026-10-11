# ADS-006I — paid reporting window provenance and evidence conflicts

Stacked on ADS-006F (PR #336). Code and tests only: not merged, not deployed, no provider call, no credential read.

## Defects found in the ADS-006F collector (reproduced with tests before fixing)

| # | Defect | Effect |
|---|--------|--------|
| 1 | Provider reporting dates were stored as **UTC** days. Meta Insights (`timezone_name`) and Google Ads `segments.date` (`customer.time_zone`) are **account-local** days. | Stored `window` provenance was off by the account's UTC offset; exact-window reconciliation (ADS-006H) would compare mislabelled periods. |
| 2 | "Window complete" was checked against UTC dates only. | For an account west of UTC, a still-running local day could be stored as a complete window. |
| 3 | Two windows ending at the same instant (e.g. 1–7 Oct and 5–7 Oct) collide on the snapshot identity `(scope, namespace, metric, observedAt, source)`. | The second run was recorded `completed` with `metricCount=5` while **0 rows** were persisted (`onConflictDoNothing`). |
| 4 | Re-collecting a stored window returned `replayed` without comparing values. | A provider restatement (late/refunded spend) was silently ignored; the report kept stale spend. |
| 5 | Meta returns an expired token (code 190) and throttling (4/17/32/613/80xxx) as HTTP 400. | Classified as generic `rejected`; the manual verify command could not tell an expired 60-day token apart. |

## Fixes

- Clients read and validate the provider's reporting zone (Meta `timezone_name`, Google `customer.time_zone`; Pinterest v5 analytics dates are documented as UTC). A missing or non-IANA zone fails closed before any metrics are requested.
- `window` holds the exact UTC instants of account-local midnights (DST-safe); snapshot metadata adds `reportingTimeZone` and the provider `reportDates`. The ADS-006C reader contract (`window.start/end`, `observedAt = window.end`) is unchanged.
- The collector refuses a window whose end is still in the future in the account's zone.
- Storage fails closed with `PaidEvidenceConflictError`:
  - `PAID_PROVIDER_RESTATEMENT`: same window, different values. Nothing is overwritten, and a human must review.
  - `PAID_WINDOW_END_CONFLICT`: a different window with the same end. No empty "completed" run is recorded.
- The Meta numeric error code is classified as `authentication`, `permission` or `rate_limit`. The provider message is never surfaced.
- `ads:meta:verify` also reports the account's `reportingTimeZone` and a sanitized failure class.

## Tests

- `paidAdsProviders`, `paidAdsCollection`, `metaPaidEndToEndSqlite`, `verifyMetaPaidAccount`, `paidAdsPreviewScript`: fixtures now carry provider zones. There are new regression cases for each defect above.
- `paidAdsAdminHttp` (new) runs the real Express app over in-memory SQLite:
  - 401 without a session, and 403 without `analytics.view`.
  - `NOT_COLLECTED` before collection, then `REPORT_AVAILABLE` with the account-local period.
  - No ROAS and no marketplace attribution.
  - Readiness shows configuration presence only, with no token value.
  - No POST/PUT/PATCH/DELETE route exists.
  - GET requests never write.

## Still blocked (external, not code)

- Live confirmation of the Meta account's `timezone_name`: run `ads:meta:verify` again on staging (owner-run).
- Pinterest's UTC reporting dates must be confirmed against a live Pinterest Ads account.
- Google Ads and Pinterest Ads account access and permissions.
- Reportable campaigns.
- Finalized billing evidence.
- Marketplace attribution evidence.
- Owner-approved staging collection.
