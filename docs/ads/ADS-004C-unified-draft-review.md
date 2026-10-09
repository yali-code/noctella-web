# ADS-004C — Unified review-only draft plan

A single server-side read flow now composes existing ADS-002C ERP candidate review, ADS-004A campaign briefing and existing Analytics Agent product profitability through ADS-004B EUR budget advice.

GET /api/analytics/ads/draft-plan/:productId?requestedDailyEur=2&hardDailyLimitEur=5&hardTotalLimitEur=20

- Authenticated `analytics.view` only, under existing Analytics router and no-store.
- Input validated by strict Zod query; read-only, **no POST, campaign launch, provider request, cookie, Pixel or spend**.
- Responses always include `liveProviderVerified=false`, `ownerApprovalRecorded=false`, `spendAuthorized=false`.
- For unsold originals, Analytics profitability may be `NOT_SOLD`; the existing conservative budget guard blocks instead of inventing historical profit. This is expected and must not be bypassed by fake sales.
- Existing Marketing Tags supply keyword hints; no audience demographics invented.
- Do not treat this draft result as a scheduled ad campaign or as actual Marketplace conversion data.

Remaining for a production Ads Agent: owner-vetted account/provider credentials, legal/consent audit, staging browser checks, provider real-time inventory revalidation, campaign kill switch, spend controls with idempotency and actual ad platform authorization.
