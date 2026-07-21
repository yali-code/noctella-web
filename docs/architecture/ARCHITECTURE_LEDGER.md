# Noctella ERP Architecture Ledger

## Ledger Purpose

Record architectural capabilities, decisions, invariants, technical debt, deferred work, validation results, and next-sprint entry conditions.

## Existing Architecture Rules

```text
Repository
↓
Application Service
↓
Use Cases
↓
Domain
↓
Repository
```

- Repositories must remain persistence-only.
- Routes must remain thin: validation, mapping, and delegation only.
- Application Services orchestrate only.
- Keep business rules inside Use Cases.
- Preserve API contracts.
- Do not duplicate business logic.
- Do not duplicate repositories.
- Do not duplicate services.
- Reuse existing services and repositories whenever possible.

## Development Policy

- One sprint has one objective.
- Every sprint starts from `main` on a dedicated branch.
- Codex READY FOR PR does not authorize merge.
- Merge requires ChatGPT architect review.
- Required review includes build, typecheck, architecture audit, focused regression, repository audit, and final diff review.
- Every major architectural milestone receives a GitHub Release and tag as a recovery checkpoint before the next risky implementation phase.

## Sales Modernization Status

Sales modernization is complete:

- Repository Foundation
- Application Context
- Use Cases
- Completion Coordinator
- Complete Sale
- Application Adapter
- Service Migration
- Atomic Internal Sale Capability
- Route Migration
- Legacy Cleanup

## Inventory Status

- Architecture audit completed.
- Capability audit completed.
- Capability review completed.
- Transaction capability types merged.
- Sprint 35D driver-aware transaction runtime implemented.
- Order creation, sale rollback, and return completion migrated to driver-aware, transaction-scoped Inventory repositories (Sprints 35N-B1, 35N-B2, 35N-C1).
- Legacy general UnitOfWork Inventory and stock repository access removed (Sprint 35N-C2).

## Inventory Invariants

- `better-sqlite3` managed transaction callbacks must not return Promises.
- SQLite managed transaction callbacks must remain genuinely synchronous.
- `db.transaction(async () => {})` is prohibited.
- Never emulate transactions using manual `BEGIN`/`COMMIT`.
- Do not weaken atomicity.
- Preserve rollback guarantees.
- Balance mutation, optimistic version checking, idempotency reservation, and stock movement must share one transaction boundary.
- Driver and transaction capability pairing must be explicit.
- Pass-through UnitOfWork must not claim atomicity.
- Post-commit failures must not report a committed transaction as failed.
- Repositories remain persistence-only.
- Routes remain thin.
- Application Services orchestrate only.
- Business rules remain inside Use Cases.
- API contracts remain unchanged.

## Validation Standard

```text
npm run typecheck
npm run build
npm run lint
npm test --workspaces --if-present
npm run architecture:audit -w apps/api
npm run repo:parity -w apps/api
```

- Focused regressions are required for sprint scope.
- A timeout is not a successful result.
- Validation results must not be invented.
- Final diff and unrelated-file review are mandatory.

## Recovery Checkpoint

- Release: Noctella ERP v1.4 — Sales Complete & Inventory Transaction Baseline
- Tag: `v1.4`
- Commit: `896b7cfaf5beb911ae24381bc29e56c5287c48df`
- Purpose: Stable rollback checkpoint before Inventory Driver-Aware Transaction Runtime.

## Reusable Sprint Template

## Sprint <ID> — <Name>

Date:
Status:
PR:
Commit:

### Capability Added
- ...

### Dependencies Introduced or Changed
- ...

### Architectural Decisions
- ...

### Invariants
- ...

### Technical Debt
- None / ...

### Deferred Work
- ...

### Entry Conditions for Next Sprint
- ...

### Validation
- Build:
- Typecheck:
- Lint:
- Tests:
- Architecture audit:
- Repository audit:
- Focused regressions:
- Full suite:
- Final diff review:

## Sprint 35C-L — Architecture Ledger Foundation

### Capability Added

- Architecture Ledger foundation created.

### Dependencies Introduced or Changed

- None.

### Architectural Decisions

- Sprint architecture history and validation are recorded in one living ledger.
- Large future decisions may use separate ADR files.
- Only factual changes and actual validation results may be recorded.

### Technical Debt

- None introduced.

### Deferred Work

- `CURRENT_INVARIANTS.md`
- ADR files
- Sprint 35D runtime implementation

### Entry Conditions for Sprint 35D

- Ledger merged into `main`.
- Working tree clean.
- Sprint 35D branch created from updated `main`.
- Existing Inventory capability types confirmed.
- No source, schema, or API contract changes introduced.

## Sprint 35D — Inventory Driver-Aware Transaction Runtime

### Capability Added

- SQLite Inventory transaction-scoped persistence executes synchronously inside managed transactions; PostgreSQL persistence remains asynchronous.
- Driver and transaction capability mismatches are rejected before execution.

### Dependencies Introduced or Changed

- No package dependencies changed.
- Inventory application contexts now pair repository drivers with matching transaction capabilities.

### Technical Debt

- None introduced.

### Entry Conditions for Next Sprint

- Sprint 35D focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35E — Inventory Runtime Integration Audit

### Capability Added

- Inventory runtime entry points, UnitOfWork wiring, application-layer bypasses, and direct repository access were audited and recorded.

### Dependencies Introduced or Changed

- None.

### Technical Debt

- Purchase receipt mutates Inventory repositories through the general UnitOfWork instead of approved Inventory Use Cases and the Inventory-specific driver-aware capability.
- Order, return, and product-write paths can mutate the same Inventory state outside the Inventory application layer.
- ERP Inventory read routes and stock reconciliation query persistence directly.
- Caller-supplied pass-through Inventory UnitOfWork implementations have no driver or execution identity and cannot prove atomicity.

### Entry Conditions for Next Sprint

- This audit receives architecture review and is merged without runtime, API, schema, migration, or test changes.
- Any correction sprint selects one recorded execution path and defines its atomic boundary before implementation.

## Sprint 35F — Purchase Inventory Runtime Migration

### Capability Added

- Purchase receipt Inventory balance and stock-movement mutations execute through the Inventory increase Use Case within the purchase receipt transaction boundary.
- SQLite receipt transactions use synchronous transaction-scoped Inventory repositories; PostgreSQL retains asynchronous repository execution.

### Dependencies Introduced or Changed

- The receive-purchase Use Case delegates linked-line Inventory mutations to the Inventory application layer.
- The general SQLite UnitOfWork supplies the existing synchronous Inventory repository capability inside its managed transaction.

### Technical Debt

- Order, return, ERP, reconciliation, and product-write Inventory mutation paths remain outside this migration scope.

### Entry Conditions for Next Sprint

- Sprint 35F focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35G — Order Inventory Runtime Migration

### Capability Added

- Order creation and sale rollback balance and stock-movement mutations execute through Inventory Use Cases inside the existing order transaction boundary.
- SQLite order transactions use synchronous transaction-scoped Inventory repositories; PostgreSQL Inventory persistence retains asynchronous execution.

### Dependencies Introduced or Changed

- The internal-order and sale-rollback Use Cases delegate Inventory mutations to the Inventory application layer.
- The general UnitOfWork continues to provide the existing transaction-scoped Inventory repository capability.

### Technical Debt

- Return, ERP, reconciliation, and product-write Inventory mutation paths remain outside this migration scope.

### Entry Conditions for Next Sprint

- Sprint 35G focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35H — Return Inventory Runtime Migration

### Capability Added

- Return completion Inventory balance and stock-movement mutations execute through an Inventory Use Case inside the existing return transaction boundary.
- SQLite return transactions use synchronous transaction-scoped Inventory repositories; PostgreSQL Inventory persistence retains asynchronous execution.

### Dependencies Introduced or Changed

- The return completion Use Case delegates ReturnIn Inventory mutations to the Inventory application layer.
- The general UnitOfWork continues to provide the existing transaction-scoped Inventory repository capability.

### Technical Debt

- ERP, reconciliation, and product-write Inventory mutation paths remain outside this migration scope.

### Entry Conditions for Next Sprint

- Sprint 35H focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35I — Inventory Runtime Finalization (Phase 1)

### Capability Added

- ERP purchase receipt Inventory balance and stock-movement mutations execute through the approved Inventory increase Use Case inside the existing receipt transaction.
- SQLite ERP receipt mutations use synchronous transaction-scoped Inventory repositories.

### Dependencies Introduced or Changed

- The ERP purchasing bridge delegates linked receipt-line Inventory mutations to the existing Inventory application layer.

### Technical Debt

- Product-write Inventory mutation paths remain outside this phase.

### Entry Conditions for Next Sprint

- Sprint 35I focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35J — Product Write Inventory Runtime Migration

### Capability Added

- Product creation and update stock quantities execute through Inventory Use Cases inside the product persistence transaction boundary.
- SQLite product writes use synchronous transaction-scoped Inventory repositories; PostgreSQL product writes retain asynchronous execution.

### Dependencies Introduced or Changed

- Product create and update Use Cases delegate quantity initialization and adjustment to the Inventory application layer.

### Technical Debt

- None introduced.

### Entry Conditions for Next Sprint

- Sprint 35J focused regressions and required validation pass.
- Final diff receives architecture review before merge.

## Sprint 35K — Product Write Transaction Capability

### Capability Added

- Product Write product create and update persistence can execute through a driver-aware transaction capability.
- SQLite execution is synchronous inside a better-sqlite3 managed transaction; PostgreSQL execution remains asynchronous.
- Explicit driver and execution capability mismatches are rejected.

### Dependencies Introduced or Changed

- The capability reuses the existing Product Write repository implementation and mappings through transaction-scoped repository construction.

### Technical Debt

- Product Write Use Cases are not migrated to this capability in Sprint 35K.

### Entry Conditions for Next Sprint

- Sprint 35K focused regressions and required validation pass.
- A later migration preserves the shared Product Write and Inventory atomic boundary and existing public repository contracts.

## Sprint 35L — Complete Product Write Runtime Migration

### Capability

- Product create and update persist Product Write metadata and delegate stock mutations to Inventory Use Cases inside the driver-aware Product Write transaction capability.
- SQLite executes the combined Product Write and Inventory callback synchronously; PostgreSQL executes it asynchronously.

### Dependency

- The migrated production paths depend on the Sprint 35K Product Write transaction capability and the existing Inventory transaction-scoped repository bundle.

### Technical Debt

- Inventory repositories remain available from the general UnitOfWork for paths outside this sprint.

### Entry Conditions

- Product create and update callers must supply a Product Write transaction capability whose driver and execution mode match the database driver.

## Sprint 35M — Inventory Runtime Final Parity Audit

### Capability

- Production Inventory mutation entry points and their transaction capability pairing were audited and recorded.

### Dependency

- Purchase receipt, order creation, sale rollback, and return completion depend on transaction-scoped Inventory repositories supplied by the general UnitOfWork.
- Product create and update depend on the driver-aware Product Write capability and its transaction-scoped Inventory repositories.
- ERP purchase receipt depends on a SQLite transaction and synchronous transaction-scoped Inventory repositories.

### Technical Debt

- The general UnitOfWork still exposes Inventory repositories and the legacy stock repository bundle.
- Unused legacy stock mutation exports remain in production source.
- Caller-supplied UnitOfWork interfaces for Inventory, purchase, sales, and return construction do not identify driver or execution mode.
- The ERP purchasing bridge has no PostgreSQL transaction branch.

### Entry Conditions

- Migrate purchase, order, sale rollback, and return Inventory repository access away from the general UnitOfWork before removing its Inventory repositories.
- Resolve the remaining legacy stock mutation exports before removing the general UnitOfWork stock repository bundle.
- Preserve synchronous SQLite and asynchronous PostgreSQL pairing in any replacement composed transaction boundary.

## Sprint 35N-A1 — Purchase Inventory Dependency Migration

### Capability

- Purchase receipt and ERP purchasing receipt Inventory mutations resolve driver-aware Inventory repositories from the active purchase transaction database without reading Inventory repositories from the general UnitOfWork.

### Dependency

- Purchase receipt depends on the existing Inventory increase Use Case and driver-aware Inventory repository runtime inside the existing purchase UnitOfWork transaction.
- ERP purchasing receipt depends on the migrated purchase receipt Use Case.

### Technical Debt

- The general UnitOfWork still exposes Inventory repositories for order creation, sale rollback, and return completion.

### Entry Conditions

- Any later removal of general UnitOfWork Inventory repositories must first migrate order creation, sale rollback, and return completion while preserving their atomic boundaries.

## Sprint 35N-B1 — Order Inventory Runtime Migration

### Capability

- Order creation Inventory balance and stock-movement mutations resolve a driver-aware, transaction-scoped Inventory repository bundle built directly from the active order transaction database, replacing the general UnitOfWork's `inventoryRepositories` property for this path.

### Dependency

- `createInternalOrderUseCase` accepts a trailing optional `driver` parameter (default `sqlite`) and constructs Inventory repositories via `createInventoryRepositoryBundleForDb(repositories.db, driver, driver === "sqlite")` inside the existing order transaction boundary.

### Technical Debt

- Sale rollback and return completion still read Inventory repositories from the general UnitOfWork.

### Entry Conditions

- Sale rollback migrates to the same pattern before the general UnitOfWork's Inventory repositories can be removed.

## Sprint 35N-B2 — Sale Rollback Inventory Runtime Migration

### Capability

- Sale rollback Inventory restoration resolves the same driver-aware, transaction-scoped Inventory repository bundle pattern established in Sprint 35N-B1, replacing the general UnitOfWork's `inventoryRepositories` property for this path.

### Dependency

- `createSaleRollbackUseCase` accepts the same trailing optional `driver` parameter (default `sqlite`) and constructs Inventory repositories via `createInventoryRepositoryBundleForDb(repositories.db, driver, driver === "sqlite")` inside the existing sale rollback transaction boundary.

### Technical Debt

- Return completion still reads Inventory repositories from the general UnitOfWork.

### Entry Conditions

- Return completion migrates to the same pattern before the general UnitOfWork's Inventory repositories can be removed.

## Sprint 35N-C1 — Return Inventory Runtime Migration

### Capability

- Return completion Inventory restoration resolves the same driver-aware, transaction-scoped Inventory repository bundle pattern, replacing the general UnitOfWork's `inventoryRepositories` property for this path.

### Dependency

- `completeReturnUseCase` accepts the same trailing optional `driver` parameter (default `sqlite`) and constructs Inventory repositories via `createInventoryRepositoryBundleForDb(repositories.db, driver, driver === "sqlite")` inside the existing return completion transaction boundary.

### Technical Debt

- No production caller of the general UnitOfWork's Inventory repositories remains; removal of `inventoryRepositories` and the legacy `stock` repository bundle from the general UnitOfWork is unblocked.

### Entry Conditions

- Remove `inventoryRepositories` and `stock` from the general UnitOfWork's `TransactionScopedRepositories` and remove confirmed dead legacy stock mutation code.

## Sprint 35N-C2 — Legacy General UnitOfWork Inventory Removal

### Capability

- The general UnitOfWork no longer exposes `inventoryRepositories` or the legacy `stock` repository bundle; both were removed from `TransactionScopedRepositories` and from `SqliteUnitOfWork` and `PostgresUnitOfWork` construction.
- Confirmed-dead legacy stock mutation code was removed: `createManualStockAdjustmentUseCase`, `applyStockMovementSync`, `applyStockMovementCompatibilitySync`, and `services/stockMovementCompatibility.ts`.

### Dependency

- No production path depends on the removed properties or functions. The canonical manual stock adjustment route continues to use `createInventoryApplicationContextForDb` and Inventory Use Cases, unaffected by this removal.

### Technical Debt

- `src/scripts/stockRepositoryAudit.ts` retains a legacy compatibility-audit path (`auditStockCompatibilitySource`, `runStockRepositoryAudit`) that reads the now-deleted `services/stockMovementCompatibility.ts` by path. It has no remaining caller and is not wired into any build, lint, or `repo:parity` script, so it is inert but not yet cleaned up.
- `src/application/sales/completionWorkflowAudit.ts` retains a stale descriptive string reference to `applyStockMovementSync` inside a static planning-audit data table. It is not imported or executed as code.

### Entry Conditions

- A follow-up sprint may remove the dead `stockRepositoryAudit.ts` compatibility-audit path and update the stale `completionWorkflowAudit.ts` string reference. Neither blocks further Inventory or transaction-runtime work.
