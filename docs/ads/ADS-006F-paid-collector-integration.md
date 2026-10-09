# ADS-006F — Provider-specific paid analytics ingestion (DRAFT, not live)

Paid analytics is architecturally separate from Instagram organic publishing, Pinterest organic Pins analytics, eBay listings and website pixel tracking. All provider clients are **read-only**, server-only and accept credentials only via explicit caller injection. No backend routes, scheduler, OAuth callback, ad-creation, pause, spend or publishing commands call this service.

## Integration contract
`collectPaidCampaignEvidence(db,client,query,access,{explicitReadApproval,explicitSnapshotWriteApproval})`: requires explicit backend-level read approval **before** making any network request. Preview-only mode makes no SQLite writes. Snapshot write mode persists **only** valid EUR paid observations with immutable run/source identity and an exclusive UTC report-window end. Uses existing `analytics_runs` and `analytics_metric_snapshots`, idempotent on account/campaign/window/source; no new database or migration. Do **not** pass approval booleans via user/browser API.

Credentials are separate from organic connectors. The eventual application integration should provide an encrypted paid-account credential store and OAuth scopes/expiry checks, then introduce an independently approved internal job. No such activation is present in this PR. The existing read-only Admin report remains `NOT_COLLECTED` until an authorized paid collector genuinely writes verified data.

- Meta: Graph Marketing API v26.0 `GET /act_<id>` for EUR account currency and `GET /act_<id>/insights` with campaign-level filtering and explicit date range. Pagination and campaign/window identity checked.
- Google Ads: REST v25 `GoogleAdsService.SearchStream` with **SELECT-only GAQL**; developer token required, EUR `customer.currency_code` verified, cost converted from micro-units to EUR cents. Fractional cents are rounded and flagged, never silently converted between currencies.
- Pinterest Ads: v5 `GET /ad_accounts/<id>` to verify EUR and `GET /ad_accounts/<id>/campaigns/analytics` for only the identified campaign; no reuse of organic Pin Analytics.
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
