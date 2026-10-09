# ADS-002C.4 — ERP Candidate Read Integration (review only)

The Ads Agent now has a server-side, read-only entry function `readAdsCampaignReviewFromErp(db, productId, now)`. It reuses, without replacement:
- Product-read repository for product status, pause, category and identity;
- ADS-002C.3 warehouse reservation-safe SELECT inventory reader;
- Existing Sprint 140 product Marketing Tags service;
- Existing marketplacePublishing external listing read service;
- Existing stock sync inventory snapshots and open conflicts tables.

## Review gate

A marketplace listing only reaches the review projection if:
1. Product is published, not paused, and reservation-aware availability is positive and internally coherent.
2. Listing is exactly active and is eBay or Etsy with an accepted URL + matching listing ID.
3. A provider inventory snapshot reports at least one unit and was captured within the last 24 hours.
4. Local listing record also updated within the last 24 hours.
5. There is no open stock sync conflict associated with the product/channel/listing.

No snapshot, stale data, ambiguous status, invalid quantity or conflict means the listing is excluded. Exclusions caused by evidence gates yield `NO_LISTING` in the downstream pure projection: *this is not a provider-derived reason*. Do not present it as proof a listing does not exist.

## Important constraints and remaining work

Local snapshots are historical, **not** a live provider availability confirmation. This read is for candidate review only. Never permit paid campaign creation or click routing based solely on it. No public API or admin page is exposed; no ad automation runs. Future implementation must obtain a fresh provider status/stock response at action time and implement automatic ad pause for sold/reserved/conflicted products.

Code currently supports production SQLite; PostgreSQL/Supabase are foundations only, not the live database. Validate adapter with real staging SQLite fixtures and transaction/race conditions before any user-facing candidate display. In particular, verify the relationship between `marketplace_inventory_snapshots.external_listing_id` and the internal `external_listings.id` in collected records; mismatch must fail closed.

This PR creates no table, alters no ERP state, records no pixel, imports no provider credentials, and does not authorize ad spend.
