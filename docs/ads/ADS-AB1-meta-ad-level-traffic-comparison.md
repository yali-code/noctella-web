# ADS-AB1 — Meta ad-level A/B traffic diagnostic (Draft, staging-only)

Tracking: [#399](https://github.com/yali-code/noctella-web/issues/399), Ads Agent [#335](https://github.com/yali-code/noctella-web/issues/335).

## Why this is separate from E06/E07

The existing E06/E07 collector requests Meta Insights with `level=campaign`, then persists trusted campaign-level daily EUR spend, impressions and **all clicks** in Analytics Agent. That works and was operator-verified for 2026-10-13, but cannot distinguish Ad A from Ad B inside a campaign. The existing Analytics Experiment Registry is a separate general-purpose research feature, **not proof of native Meta randomized A/B assignment**.

ADS-AB1 introduces **code and synthetic tests only** for an **explicit, manual, staging-only, read-only** ad-level preview. It does not replace or alter E06/E07, schema, Admin pages, cron jobs or production services. There is no real ad pair approved or inspected in this task.

## Inputs and strict scope

The manual command `npm run ads:meta:ab:preview -w apps/api` only runs on the Render **staging API** with the expected SQLite target string. The script does **not open SQLite**; the target string is verified solely to reject the wrong service. Use command-scoped environment variables, **never permanent credentials or acknowledgements in GitHub or Render configuration**:

| Variable | Purpose |
| --- | --- |
| `NOCTELLA_META_AD_ACCOUNT_ID` | Existing configured Meta Ads account (numeric) |
| `NOCTELLA_META_AD_ACCESS_TOKEN` | Existing dedicated paid Ads `ads_read` token; never display it |
| `NOCTELLA_AB_CAMPAIGN_ID` | Exact numeric parent campaign ID |
| `NOCTELLA_AB_AD_A_ID`, `NOCTELLA_AB_AD_B_ID` | Two **distinct real ad IDs**, never fabricated |
| `NOCTELLA_AB_START_DATE`, `NOCTELLA_AB_END_DATE` | Identical reporting-date interval for both variants, account-local YYYY-MM-DD |
| `NOCTELLA_PAID_ADS_PREVIEW_ACK` | Must be `I_AUTHORIZE_PAID_READ_ONLY` |
| `NOCTELLA_AB_PREVIEW_ACK` | Additional separate per-invocation value `I_AUTHORIZE_META_AD_AB_READ_ONLY` |

**Do not run the command on a live account merely because a Draft PR or old campaign-level read approval exists.** First obtain a **new explicit owner authorization covering the exact ad IDs and date range** and verify they are real ads under the specified campaign. The read-only command does not self-authenticate the user; the backend-only manual environment and owner-approved scope are the boundary.

Provider requests (only after all local guards):
1. Meta Graph account GET for account identity, EUR currency and IANA account timezone.
2. Meta Graph Insights GET with `level=ad`, exact `campaign.id` + two-item `ad.id IN` filter, identical `time_range`, numeric spend/impressions/clicks and no pagination. The two reports must match the requested IDs, parent campaign and full account-local period. Missing, duplicate, extra, incomplete or paginated reports fail closed. Provider token and raw provider errors are not logged.

The command prints safe metadata, two ad-level rows, verdict and hard false flags:
`databaseWritePerformed:false`, `campaignModified:false`, `spendAuthorized:false`,
`causalAbWinnerVerified:false`, `marketplaceAttributionVerified:false`, `marketplaceRoas:null`.

## Interpreting a verdict

- `DATA_QUALITY_REVIEW`: invalid/contradictory numeric evidence; do not compare.
- `INSUFFICIENT_EVIDENCE`: missing metrics, under 1,000 impressions or 30 **all clicks** per ad, or no positive EUR spend. No missing data is replaced with 0.
- `NO_CLEAR_TRAFFIC_DIFFERENCE`: the two-sided pooled CTR z-score is below 1.96 **or** CTR and CPC point in conflicting directions.
- `DIRECTIONAL_TRAFFIC_LEAD`: both thresholds are met, |z| >= 1.96 and the ad with higher CTR has no higher **all-click** CPC than its peer. This is a **directional observational traffic signal only**. It is *not* a randomized experiment winner, not a guarantee of causality, and not a business/ROI recommendation.

CTR = all clicks / impressions; all-click CPC = EUR spend / all clicks; CPM = EUR spend / impressions * 1000. These are **not** Meta outbound/link-click metrics. The test is sensitive to repeated peeking and ad-delivery optimization: independent verified randomized allocation, predefined primary metric, design/sample and sequential analysis controls would be necessary before making a causal A/B claim. Even a causal traffic lift would **not** establish more Etsy/eBay sales without independent attribution.

## Acceptance boundaries

- Unit tests with synthetic Meta HTTP responses and pure comparison fixtures cover provenance, partial/paginated reports, numeric/data-quality failures, two distinct IDs, different account/campaign/dates, missing metrics, insufficient sample, no clear signal, conflicting CPC, and false spend/attribution flags.
- **No live provider call was made. No staging deployment, no real ad pair, no current performance claim.** Draft PR requires CI/typecheck/review, then separate staging deploy approval; later any real read needs another explicit ad/date-scoped authorization.
- Next potential phases, **not included or approved**: (a) owner-authenticated Admin read-only A/B panel, (b) ad-level snapshot persistence/idempotency with staging backup, (c) verified native Meta Experiments assignment and suitable confidence method, (d) externally attributable marketplace conversions. None of those should be inferred from ADS-AB1.
