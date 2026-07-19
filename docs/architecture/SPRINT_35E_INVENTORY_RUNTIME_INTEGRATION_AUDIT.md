# Sprint 35E — Inventory Runtime Integration Audit

## Result

The `/api/stock-movements` write route and the ERP stock-adjustment command reach Inventory Use Cases through `stockMovements.ts`; their database-backed context is created by `createInventoryApplicationContextForDb`, which selects an explicit driver-matched capability. SQLite uses a synchronous managed transaction and transaction-scoped synchronous repositories. PostgreSQL and Supabase PostgreSQL use asynchronous managed transactions and matching repositories.

The approved Inventory runtime is not yet the only production path that mutates inventory state.

## Runtime Entry Points

| Entry point | UnitOfWork path | Finding |
| --- | --- | --- |
| `routes/stockMovements.ts` GET and POST | `stockMovements.ts` → `createInventoryApplicationContextForDb(db)` | Uses the approved runtime; the driver is resolved from `DATABASE_DRIVER`. |
| `routes/erp.ts` product stock-adjustment command | `erpInventoryBridge.ts` → `applyStockMovement` → `stockMovements.ts` → `createInventoryApplicationContextForDb(db)` | Inventory mutation uses the approved runtime. ERP command acceptance/completion records are separate transactions, so the entire command is not atomic with the stock mutation. |
| `purchase/useCases.ts` receive-purchase flow | `purchaseApplicationContextForDb.ts` → general `SqliteUnitOfWork` or `PostgresUnitOfWork` → `inventoryRepositories` | Mutates Inventory repositories directly outside approved Inventory Use Cases and does not use the approved Inventory transaction capability. |
| Order creation and sale rollback | general `UnitOfWork` → legacy `stock` repository | Mutates the same product balance and stock-movement ledger outside the Inventory application layer and approved Inventory runtime. |
| Return completion | general `UnitOfWork` → legacy `stock` repository | Mutates the same product balance and stock-movement ledger outside the Inventory application layer and approved Inventory runtime. |
| Product create/update services | product-write path | Can set `products.stockQuantity` outside Inventory Use Cases and the approved Inventory runtime. |
| `buildInventoryApplicationContext` callers | caller-supplied `PassThroughInventoryUnitOfWork` | Public construction can receive a pass-through implementation with no driver/execution identity; tests use such implementations. It cannot prove atomicity. No production route-wired service constructs this context directly. |
| General `services/unitOfWork.ts` | constructs `inventoryRepositories` for every transaction | Remains an Inventory-repository-bearing UnitOfWork entry point. SQLite and PostgreSQL are explicitly paired there, but it is not the approved Inventory-specific capability. |

## Bypasses and Direct Access

- `application/purchase/useCases.ts` directly calls transaction-scoped Inventory repositories during receipt.
- `routes/erp.ts` directly queries products and stock movements for Inventory projections, including `/products/:id/movements`; these read routes bypass the Inventory application layer.
- `services/stockReconciliation.ts` directly queries products and stock movements for a read-only reconciliation projection.
- Legacy stock, order, return, and product-write paths own Inventory-affecting writes independently of Inventory Use Cases.
- No direct Inventory repository implementation import was found in an Inventory HTTP route. The route-wired stock-movement service delegates Inventory operations to Inventory Use Cases.

## Capability Confirmation

- SQLite production Inventory entry: explicit `sqlite` capability, `execution: "synchronous"`, synchronous transaction-scoped repositories, and rejection of Promise-returning callbacks.
- PostgreSQL production Inventory entry: explicit `postgres` capability, `execution: "asynchronous"`, and PostgreSQL transaction-scoped repositories.
- Supabase PostgreSQL follows the PostgreSQL capability branch and repository factory.
- Driver/capability mismatch is rejected by `createInventoryApplicationContextForDb`.
- The production stock-movement service relies on `DATABASE_DRIVER` rather than passing the driver at its call site; resolution is explicit inside context creation.

## Remaining Risk

Atomicity is established for mutations executed through the approved Inventory Use Cases and driver-aware context. It must not be inferred for ERP command bookkeeping, caller-supplied pass-through contexts, purchase receipt Inventory mutations, or legacy stock/product write paths.
