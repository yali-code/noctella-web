# ADS-002C.2 — ERP Inventory Read Guard

## Critical discovery from verified repository code

`apps/api/src/repositories/product-read/drizzle.ts` currently returns `getAvailabilityProjection` with `reservedStockSupported: false`, `reservedStock: 0` and `availableQuantity: stockQuantity`. This is NOT proof that orders or warehouse reservations are accounted for. Ads must fail closed rather than assuming a camera with one physical unit is safe to advertise.

Separately, `apps/api/src/services/erpWarehouseBridge.ts` contains `availability(db, productId)` which checks Active stock reservations, but also invokes `expireReservations(db)` (a potential write). It is not a read-only Ads Agent reader. Do not wire it into Ads campaign listing without a transaction/audit. Marketplace stock statuses also need normalization and freshness checks.

## This change

- Adds an injected read-only integration boundary that consumes the existing `ProductAvailabilityProjection` contract, existing product fields, Sprint 140 Marketing Tags keys and external listing facts.
- Requires `reservedStockSupported: true`, coherent quantities, matching product identity and positive available stock.
- Delegates URL/identity/listing/published checks to existing ADS-002A/ADS-002C.1 pure logic.
- Owner approval and `spendAuthorized: false` remain invariant.
- No API route, schema, database changes, background tasks, marketplace API call, pixel or ad spend.

## Follow-on production integration gates

1. Identify/implement an authoritative read-only inventory projection that subtracts all relevant holds/reservations/orders without mutating reservation state.
2. Validate if warehouse reservations and product stock movements are both authoritative for production SQLite. Never silently overcount/undercount reserved stock.
3. Reconcile local and remote inventory and listing activity; check stock conflicts, listing updatedAt freshness and provider-specific active statuses before ad launch.
4. Design a stock-change invalidation/stop mechanism with provider ad pause and evidence; no automatic spend before owner approval.
5. Review legal/consent/network audit and Google/Meta/Pinterest vendor settings separately.

This is a guard and DI contract; it does not assert any real product can currently be safely advertised.
