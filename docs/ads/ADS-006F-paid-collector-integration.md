# ADS-006F — Provider-specific paid analytics ingestion (DRAFT, not live)

Paid analytics is architecturally separate from Instagram organic publishing, Pinterest organic Pins analytics, eBay listings and website pixel tracking. All provider clients are **read-only**, server-only and accept credentials only via explicit caller injection. No backend routes, scheduler, OAuth callback, ad-creation, pause, spend or publishing commands call this service.

## Integration contract
`collectPaidCampaignEvidence(db,client,query,access,{explicitReadApproval,explicitSnapshotWriteApproval})`: requires explicit backend-level read approval **before** making any network request. Preview-only mode makes no SQLite writes. Snapshot write mode persists **only** valid EUR paid observations with immutable run/source identity and an exclusive UTC report-window end. Uses existing `analytics_runs` and `analytics_metric_snapshots`, idempotent on account/campaign/window/source; no new database or migration. Do **not** pass approval booleans via user/browser API.

Credentials are separate from organic connectors. The eventual application integration should provide an encrypted paid-account credential store and OAuth scopes/expiry checks, then introduce an independently approved internal job. No such activation is present in this PR. The existing read-only Admin report remains `NOT_COLLECTED` until an authorized paid collector genuinely writes verified data.

- Meta: Graph Marketing API v26.0 `GET /act_<id>` for EUR account currency and `GET /act_<id>/insights` with campaign-level filtering and explicit date range. Pagination and campaign/window identity checked.
- Google Ads: REST v25 `GoogleAdsService.SearchStream` with **SELECT-only GAQL**; developer token required. Run an independent `FROM customer` query first to prove the selected customer ID and EUR `customer.currency_code`, **even if campaign results are empty**, then fetch the campaign report. Malformed, missing or non-EUR customer evidence blocks the campaign request; no invented EUR evidence. Cost is converted from micro-units to EUR cents. Fractional cents are rounded and flagged, never silently converted between currencies.
- Pinterest Ads: v5 `GET /ad_accounts/<id>` to strictly verify explicit account ID and EUR; then `GET /ad_accounts/<id>/campaigns/analytics` for only the identified campaign, using the documented `SPEND_IN_MICRO_DOLLAR` metric (micro-units of the verified advertiser currency). EUR cents are rounded with a warning if sub-cent values are present. No reuse of organic Pin Analytics.
- All three: provider-reported conversions and conversion value deliberately remain null. eBay/Etsy orders and outbound clicks never become advertising Purchase events.

Source documentation reviewed:
- https://www.postman.com/meta/facebook-marketing-api/request/u38qbri/get-insight-details-from-an-adaccount-l4
- https://developers.google.com/google-ads/api/docs/get-started/make-first-call
- https://developers.google.com/google-ads/api/docs/query/cookbook
- https://developers.pinterest.com/docs/analytics-and-reports/ads-reporting/
- https://www.postman.com/pinterest/pinterest-collections/request/w55vzxa/get-campaign-analytics

## Connection checklist (owner handles later)
1. Create separate paid-ad app/account access with appropriate verified read-only reporting scopes. Do not paste any tokens into GitHub/ChatGPT or copy the organic publishing token.
2. Grant/verify account, customer/developer credentials and EUR billing currency.
3. Inject credentials only at trusted server entrypoint; authenticate the account and check token refresh/expiry.
4. Run mock transport tests, then use staging test account with explicit read approval; compare provider figures with platform reporting UI.
5. Only after these checks allow opt-in analytics snapshot writes. **Never** interpret this as permission to purchase ads.
6. Full Phase 6 closeout additionally needs genuine spend reconciliation and staging/production rollout approval.

No changes to production SQLite, photo backup or Render settings. This PR must remain Draft/unmerged until separately instructed.

## Manual read-only smoke test (only after provider setup)

The code includes `npm run ads:paid:preview -w apps/api`. This is **not** a background job or public HTTP endpoint, and does not create/open the ERP SQLite database. It requires all of these as secure server environment variables:

- `NOCTELLA_PAID_ADS_PREVIEW_ACK=I_AUTHORIZE_PAID_READ_ONLY` — explicit human-triggered reporting read consent
- `NOCTELLA_PAID_ADS_PROVIDER=meta` (alternatives `google_ads`, `pinterest_ads`)
- `NOCTELLA_PAID_ADS_CAMPAIGN_ID` — actual numeric paid campaign ID
- `NOCTELLA_PAID_ADS_START_DATE`, `NOCTELLA_PAID_ADS_END_DATE` — complete past UTC dates (inclusive), maximum 31 days
- Meta: `NOCTELLA_META_AD_ACCOUNT_ID`, `NOCTELLA_META_AD_ACCESS_TOKEN` (must be real **paid Ads** permissions)
- Google: `NOCTELLA_GOOGLE_ADS_CUSTOMER_ID`, `NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN`, `NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN`; optional `NOCTELLA_GOOGLE_ADS_MANAGER_CUSTOMER_ID`
- Pinterest: `NOCTELLA_PINTEREST_AD_ACCOUNT_ID`, `NOCTELLA_PINTEREST_AD_ACCESS_TOKEN`

Do not paste token values in code, logs, tickets, chat or terminal transcripts. The command returns only provider/currency, UTC window, raw EUR ad spend, impressions, clicks, warning codes, and `storagePerformed:false`, `campaignModified:false`, `spendAuthorized:false`. If a live provider fails, an intentionally generic error is displayed without provider response bodies.

**Important:** The manual preview is the first safe step *after* the account owner grants real Ads API permissions. It does not prove spend reconciliation, billing access or eBay/Etsy purchase attribution and must not be promoted automatically to production.


## Zero-campaign Meta account verification (manual only)

The existing per-campaign `ads:paid:preview` script requires a real campaign ID and is
**not applicable before the first campaign exists**. For initial Meta onboarding use:

```bash
NOCTELLA_PAID_ADS_PREVIEW_ACK=I_AUTHORIZE_PAID_READ_ONLY npm run ads:meta:verify -w apps/api
```

Run the command only from a trusted environment that already has
`NOCTELLA_META_AD_ACCOUNT_ID` and `NOCTELLA_META_AD_ACCESS_TOKEN` configured
as protected server environment variables. The acknowledgement is intentionally
per-command; do not persist it in the service environment or schedule this script.

The command checks account identity and EUR currency and executes two Meta Graph
**GET** requests (account fields and yesterday's account-level Insights). An empty
successful `data: []` is accepted as **verified read access, 0 report rows**.
It prints no token, access headers, provider response body, spend, revenue,
campaign mutation, billing match or attributed marketplace purchases.

It performs **no ERP database read/write**, does not activate any job/route or
campaign, and requires **no actual campaign or payment method**. Result labels
`spendReconciliation: NOT_ASSESSED` and
`marketplaceAttribution: NOT_ASSESSED` must remain unchanged.

For current owner onboarding (2026-10-10), the owner independently reported
HTTP 200 for Meta account and Ads Insights, EUR and 0 report rows after
configuring the staging server token. This is **a live Meta permission check only**;
the code in this draft PR is not deployed to staging and has not performed a
full paid campaign collector run. No PR may be merged or production-deployed
without separate explicit owner approval.
