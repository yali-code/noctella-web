# ADS-002C.5 — Provider listing identity correction

## Verified mismatch

The established Stock Sync implementation (`apps/api/src/services/stockSync.ts`) writes `marketplace_inventory_snapshots.external_listing_id = listing.externalListingId`, where `listing.externalListingId` is the **eBay/Etsy provider's listing number**. Stock conflicts use the same provider ID.

ADS-002C.4 accidentally queried these tables using `external_listings.id`, the internal database row identity. The result would be missing snapshots and undiscovered listing-specific stock conflicts. This PR corrects both comparisons to the provider ID and additionally scopes snapshots to the matching marketplace channel. Existing fail-closed no-snapshot behavior remains.

## Safeguards

- Only eBay/Etsy digit-only provider IDs accepted, matching existing listing URL policy. No internal UUID or unknown channel substitution.
- Both snapshot lookups and open-conflict lookups use the provider ID, not the internal listing row ID.
- Does not make historical snapshots equal to live provider confirmation.
- No schema migration, no data rewrites, no advertising API, no live tags, no ad spend.
- Unit tests cover provider ID mapping and unsupported/malformed identities.

## Remaining gates

- CI, staging fixture verification that real external listings and Stock Sync observations join as expected, no open conflicts.
- Recheck provider stock/listing at campaign activation and automatically pause ads on sold-out items; confirm opt-in tracking and ad account ownership.
- Review whether multiple listings per product/channel require additional conflict aggregation and current-order holds before any spend.

This is a narrow repair to a **review-only** projection, not an ad-launch authorization.
