# ADS-002C.1 — Marketplace Campaign Candidate Projection

**Scope:** read-only/no side effects. No network, vendor tracking, paid campaigns, data storage, external listing API calls, or production changes. The output is **ELIGIBLE_FOR_REVIEW**, not `LIVE` or `PUBLISH`.

## Integrates existing systems rather than duplicating them

- Inputs for product IDs, titles, category and marketing tag **keys** are taken from the existing ERP product read side and Sprint 140 Marketing Tags. This PR does **not** create new tag tables.
- Product status, sale-pause and **canonical available-to-sell** values must be read from the authoritative inventory service in a later integration PR; unknown inventory fails closed.
- Listings must come from `external_listings`, with normalized active marketplace status and trusted listing IDs. It reuses the ADS-002A `evaluateFunnelLink` validation.
- Ads candidate records are a view/projection only. No Ads-owned stock or duplicate analytics snapshot database.
- Owner approval, verified spend caps and separate ad-provider authorization are mandatory before any paid campaigns.
- Marketplace click is not proof of marketplace purchase.

## Known integration gates

1. Investigate product status enum mapping (`published` versus `Published`) in actual API and ERP read projections. Do not weaken ADS-002A guards by allowing arbitrary strings.
2. Resolve authoritative available-to-sell, reservations, unfulfilled orders and marketplace stock conflicts; never read raw `stockQuantity` as the final proof of availability without audit.
3. Verify that `externalListingId` is numeric for the supported eBay/Etsy listing paths. If a valid provider adapter uses a different ID, add a proven normalization with test fixtures.
4. Validate fresh provider status before spending or redirecting. Storefront display and campaign ads need ongoing sold-item shutdown.
5. Review consent, privacy information and browser network traffic before enabling GA4, Meta or Pinterest scripts.
6. Use the existing analytics/profitability snapshot foundations to evaluate spend and verified orders, not synthetic Purchase events.
7. The existing store checkout/cart and public API projections remain unchanged.

## Next
Integrate a restricted server-side read adapter that fetches canonical product, inventory, tags and external listings into these input contracts, with database-specific focused tests before exposing any public campaign endpoint.
