# Noctella Ads Agent — Reuse / No-Duplicate Integration Contract

Status: architecture inventory verified against `main` on 2026-10-09. This is the integration contract for future Ads phases, not an implementation of a second ERP.

| Existing owner | Verified code | Ads Agent must do |
| --- | --- | --- |
| Product catalog & marketing keywords | `apps/api/src/services/marketingTags.ts` and `apps/admin/src/lib/marketingTags.ts` | Read existing product-scoped tags. Do not introduce duplicate marketing taxonomy or modify Admin-wins AI enrichment ownership. |
| Inventory & marketplace listings | `apps/api/src/db/schema.sqlite.ts`, `apps/api/src/services/marketplacePublishing.ts` | Use authoritative available-to-sell calculations and actual marketplace listing identity. Do not copy operational stock into Ads-owned mutable tables. ADS-002A pure projection is not wired to stock yet. |
| Existing analytics snapshot storage | `apps/api/src/use-cases/analytics/externalMetrics.ts`, `apps/api/src/routes/analytics.ts` | Reuse and extend existing snapshot/read model for platform reporting instead of a second social metrics collector. Keep impressions, clicks, conversions and provider windows separate with source provenance. |
| Profitability analytics | `apps/api/src/use-cases/analytics/productProfitability.ts` and profitability routes | Reference confirmed cost/profit signals for budgets, not guessed conversion value. |
| Social approval and content | `apps/api/src/routes/mediaPlanner.ts`, `apps/admin/src/app/social/page.tsx` | Reuse media and permission principles, but paid spend requires its own explicit owner approval and budget limits. Organic post approval never authorizes advertising spend. |
| Storefront consent | `apps/storefront/src/components/AdsConsentManager.tsx`, `apps/storefront/src/lib/adsConsentStorage.ts` | Reuse consent source; do not install second banner/CMP. Validate privacy/legal requirements before any real vendor script. |
| Storefront events | `apps/storefront/src/lib/adsEventPolicy.ts`, proposed `adsConsentDispatcher.ts` | Maintain one whitelist and one deny-by-default consent gate; no duplicate frontend tag manager. |
| Admin Marketing/Analytics/Live Visitors routes | `apps/admin/src/app/marketing/page.tsx`, `analytics/page.tsx`, `live-visitors/page.tsx` | Existing placeholders: build future Ads UX by extending admin navigation/pages; do not claim these placeholders are dashboards. |

## Work that has **not** been verified as operational

- No working storefront Meta Pixel, Pinterest Tag, GA4/GTM, Meta CAPI, Google Ads conversion tag, paid campaign API or marketplace order attribution was identified from repository searches.
- External scripts may still be configured outside repository through CDN, tag manager or hosting environment; must audit live/staging browser requests before any tag integration.
- Existing `marketing_tags` are product classification records, **not** browser tracking pixels.
- Existing social analytic observations are correlation and never automatically proof of ad-attributed marketplace purchase.
- An eBay/Etsy outbound click is **not** a Purchase event. Marketplace transaction verification and deduplication are separate gates.

## Feature ownership rule

One authoritative owner per capability: ERP for SKU, listing and inventory; Analytics Agent for social/marketplace metrics; Social Manager for content/media; Storefront consent module for visitor consent; Ads Agent for ad planning, budgets, provider orchestration, documented attribution confidence and owner-approved paid operations. Do not migrate production SQLite or touch off-disk R2 backups for Ads work.

## Next tasks (after PR #314 passes CI)

1. Privacy review and pre-consent/post-withdrawal browser network audit in staging.
2. Decide canonical storefront event-to-provider mapping, with separately reviewed vendor implementation and no script initialization without permission.
3. ADS-002C: read-only campaign landing/marketplace links backed by authoritative stock+listing status.
4. ADS-002D: spend/revenue reporting as additions to existing analytics projections with evidence tiers. Avoid a duplicate datastore or platform collector.
