# ADS Phase 3 — Authenticated Candidate Review Boundary

## Available API
GET /api/analytics/ads/candidates/:productId

Uses existing analytics router's `requirePermission("analytics.view")` enforcement. Invalid IDs fail validation. Response is no-store with `scope: "REVIEW_ONLY"`, `liveProviderVerified: false`, and `spendAuthorized: false`.

The endpoint reads authoritative SQLite product and Active warehouse reservation records (read-only), existing Sprint 140 Marketing Tags, existing external listings, historical inventory snapshots and stock-sync open conflicts. It uses existing ADS-002A, 002C.1–002C.5 eligibility policies. It does not create a second inventory, taxonomy, social analytics collector or ad manager.

## Important restrictions
- This is historical snapshot evidence, NOT a provider real-time stock check. No spending, pixel, tracking, provider mutation, campaign launch, stock expiry or write.
- Candidate review can become stale immediately; real campaign activation must recheck seller stock, all active orders, conflict state and live provider listing availability and must support automatic ad pause on sale.
- A missing/inconsistent reservation read or stale provider snapshot excludes the listing.
- Product tags are classifications; they are not Meta or Google tracking tags.
- Internal inventory and listing data is only accessible behind authenticated analytics.view permission; never expose it in public storefront routes.
- Production deployment/Render remains unverified; this PR is code + CI only.

## Phase 3 operational acceptance still needed
1. Staging SQLite integration fixture tests for reservations and provider IDs.
2. Provider-side current-listing check and halt/disable workflow.
3. Cross-channel sales race protection and pending-order holds.
4. Production dataset audit (read-only) before launch; no prod resets or migrations.
