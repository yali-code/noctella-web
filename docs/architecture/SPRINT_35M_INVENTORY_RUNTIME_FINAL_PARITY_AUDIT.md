# Sprint 35M — Inventory Runtime Final Parity Audit

## Result

All route-reachable production Inventory mutations delegate balance and stock-movement changes to Inventory Use Cases. The stock-movement service uses the driver-aware Inventory transaction capability. Product create and update use the driver-aware Product Write transaction capability with transaction-scoped Inventory repositories. Purchase receipt, order creation, sale rollback, and return completion use Inventory in-transaction Use Cases with transaction-scoped Inventory repositories supplied by the general UnitOfWork. ERP purchase receipt uses the Inventory increase in-transaction Use Case inside a SQLite transaction.

## Mutation Entry Points

| Production entry point | Inventory mutation boundary | Finding |
| --- | --- | --- |
| Manual and ERP stock adjustments | `stockMovements.ts` → Inventory Use Cases → `createInventoryApplicationContextForDb` | Uses the driver-aware Inventory capability. |
| Purchase receipt | Purchase UnitOfWork → `increaseInventoryInTransactionUseCase` | Uses Inventory business logic and transaction-scoped Inventory repositories from the general UnitOfWork. |
| Order creation | Order UnitOfWork → `decreaseInventoryForSaleInTransactionUseCase` | Uses Inventory business logic and transaction-scoped Inventory repositories from the general UnitOfWork. |
| Sale rollback | Order UnitOfWork → `restoreInventoryForSaleRollbackInTransactionUseCase` | Uses Inventory business logic and transaction-scoped Inventory repositories from the general UnitOfWork. |
| Return completion | Return UnitOfWork → `restoreInventoryForReturnInTransactionUseCase` | Uses Inventory business logic and transaction-scoped Inventory repositories from the general UnitOfWork. |
| ERP purchase receipt | SQLite transaction → `increaseInventoryInTransactionUseCase` | Uses Inventory business logic and synchronous transaction-scoped Inventory repositories; this bridge has no PostgreSQL branch. |
| Product create and update | Product Write capability → Inventory initialization/set Use Cases | Uses the driver-aware Product Write capability and transaction-scoped Inventory repositories in one transaction. |

## Remaining Legacy Access

- The general UnitOfWork still exposes both `inventoryRepositories` and the legacy `stock` repository bundle. Purchase receipt, order creation, sale rollback, and return completion directly consume its `inventoryRepositories` capability.
- `createManualStockAdjustmentUseCase` directly mutates the legacy `repositories.stock.stockMovements` bundle, but no production caller was found. `applyStockMovementCompatibilitySync` also directly mutates the legacy stock repository and is exported through `applyStockMovementSync`, but no production caller was found.
- No route-reachable production Inventory mutation was found using either legacy stock mutation implementation.
- `buildInventoryApplicationContext` accepts `PassThroughInventoryUnitOfWork`, which has no driver or execution identity. Its direct callers are tests; production construction uses `createInventoryApplicationContextForDb`.
- Purchase and sales database-context factories accept caller-supplied general UnitOfWork instances, and the return context accepts a caller-supplied general UnitOfWork. The default production construction is driver-matched, but the supplied interface itself does not identify driver or execution mode.

## Capability Pairing

- The Inventory and Product Write capabilities pair SQLite and test-memory with synchronous transaction callbacks and reject Promise-returning callbacks.
- The same capabilities pair PostgreSQL and Supabase PostgreSQL with asynchronous transaction callbacks and PostgreSQL repository construction.
- The general UnitOfWork pairs SQLite with synchronous transaction-scoped Inventory repositories and PostgreSQL with asynchronous Inventory repositories. Its interface does not expose driver or execution identity.

## Legacy UnitOfWork Cleanup Prerequisites

- Purchase receipt, order creation, sale rollback, and return completion must stop obtaining `inventoryRepositories` from the general UnitOfWork before that property can be removed.
- The legacy `stock` repository bundle cannot be removed from the general UnitOfWork while `createManualStockAdjustmentUseCase` depends on it; the unused production export and compatibility adapter require an explicit removal decision.
- Caller-supplied UnitOfWork options on purchase, sales, and return contexts require driver/execution validation or removal before their atomicity can be inferred from construction.
- PostgreSQL coverage is required for any replacement composed transaction boundary; the ERP purchasing bridge is currently SQLite-specific.
