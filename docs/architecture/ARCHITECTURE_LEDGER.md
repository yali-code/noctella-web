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
