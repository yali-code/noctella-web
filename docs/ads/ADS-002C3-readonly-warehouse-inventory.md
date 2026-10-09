# ADS-002C.3 — Read-only Warehouse Reservation Availability

Scope: existing SQLite products and `stock_reservations`; **no schema changes** and no ads activation.

## Why this exists
- `product-read/drizzle.ts` currently exposes `reservedStockSupported=false` and raw stock as available quantity. ADS-002C.2 correctly refuses that value.
- `erpWarehouseBridge.availability` calls `expireReservations` (writes to the warehouse). Ads must not invoke a write just to discover a candidate.
- This reader uses one scalar aggregate SELECT against existing `products` and `stock_reservations`; it includes all `Active` reservations, **even expired Active rows**, conservatively. No expiry or state mutation.
- Unknown, inconsistent or negative quantities block promotion; the existing ADS-002C.2 guard validates the resulting projection.

## Explicit limits
This reader is not yet plugged into an Ads API. It is intended as the `readAvailability` implementation for `TrustedMarketplaceCampaignReaders` once the host service and tests are reviewed.

Do NOT interpret the result as real-time external provider stock. Product sales/orders, conflicts, reservations and listing statuses can change between reading and campaign action. An ad launch requires a contemporaneous recheck, provider-side pause mechanism, account authorization, and separate owner spend approval.

No actual pixels, paid campaigns, new datastore, ad manager duplicate or live API route are introduced.
