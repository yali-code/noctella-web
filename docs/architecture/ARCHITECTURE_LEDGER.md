# Noctella ERP Architecture Ledger

## Ledger Purpose

Record architectural capabilities, decisions, invariants, technical debt, deferred work, validation results, and next-sprint entry conditions.

## Existing Architecture Rules

```text
Route
↓
Service
↓
UseCase
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

## Current Noctella Web Architecture Decisions (Sprints 114–122)

### Public Presentation

- Public Noctella Web contracts remain marketplace-neutral while the public projection uses approved marketplace-prepared values through these precedence rules: `title = wooProductName ?? title`, `description = wooLongDescription ?? description ?? undefined`, `shortDescription = wooShortDescription ?? undefined`, `priceEur = wooListingPriceEur ?? priceEur`, `seoTitle = wooSeoTitle ?? seoTitle ?? undefined`, and `metaDescription = wooMetaDescription ?? metaDescription ?? undefined`.
- Woo-specific storage fields remain internal implementation details and are not exposed as public property names. `shortDescription` has no canonical or long-description fallback.
- Customer-facing search includes `wooProductName`. Price sorting uses `coalesce(wooListingPriceEur, priceEur)`, title sorting uses `coalesce(wooProductName, title)`, and deterministic ID tie-breakers are preserved.

### Direct Noctella Web Orders

- Direct Noctella Web orders use the explicit `noctella_web` pricing context and effective unit price `wooListingPriceEur ?? priceEur`; other order contexts retain their established canonical pricing semantics.
- EUR remains authoritative. Paid amounts are compared after deterministic integer-cent normalization, and stale or mismatched checkout/payment data fails closed without silent repricing. Mock payment infrastructure is not production payment readiness.
- The direct Noctella Web order-item title is selected as `wooProductName ?? title` at creation. Its stored value is an immutable historical snapshot: later product edits do not rewrite it, and invoice drafting consumes that durable order-item title. Marketplace and other non-Noctella-Web contexts retain their established canonical behavior.

### Transaction and Inventory Boundaries

- Durable transactional work completes before external post-commit synchronization. Post-commit stock synchronization must occur after the final same-scope UnitOfWork transaction, and repository audit tooling structurally enforces that order.
- Inventory atomicity and idempotency boundaries remain authoritative, and Inventory remains the source of truth.
- Marketplace preparation does not replace Inventory authority. Marketplace fields remain optional at product creation and marketplace-specific validation remains publish-time; the Noctella Web presentation decisions above do not alter those boundaries.

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

## Sprint 142 — Publication State / Pending Publish Alignment

### Architectural Decisions

- Pending Publish now additionally excludes any Product with historical `PublishJobStatus.Succeeded` evidence, not merely a `Product.status` check — `Product.status` alone cannot represent "published to eBay/Etsy," since neither channel ever writes it.
- Authority is derived from the existing `publish_jobs` table via a correlated `NOT EXISTS` predicate in `repositories/product-read/drizzle.ts` — no new persisted publication-state field or table was introduced.
- `ProductStatus.Published` remains exclusively Noctella-Web-specific storefront-live semantics — unchanged by this sprint.
- Failed, RetryPending, and Processing PublishJob history alone does not exclude a Product from Pending Publish — only a genuine historical `Succeeded` row does.

### Entry Conditions

- No future sprint should assume a separate persisted publication-state authority exists; the existing `publish_jobs` evidence remains canonical for "has this Product ever been published to a given channel."

## Sprint 141 — Unified Channel Selection and Publishing

### Architectural Decisions

- A new batch orchestration (`executePublishBatch`) delegates every selected channel to the existing, unmodified per-channel `executePublish` — never a second publishing implementation.
- Execution is sequential and attempt-all: one selected channel's outcome never prevents a later selected channel from being attempted, and no cross-channel transaction exists.
- Each channel's outcome (succeeded/failed/skipped) is independent and reported per channel — never collapsed into a single global result.
- `ProductStatus` semantics are unchanged: eBay/Etsy success still never writes `Product.status`; only Noctella Web publication does.

## Sprint 140 — Automatic AI Sales Preparation and Marketing Tags

### Architectural Decisions

- A transactional `AiSalesPreparationRequested` Outbox intent is persisted inside the same Stock Acceptance transaction that creates the Product/Inventory row — never a separate, unguarded write.
- Post-commit AI sales preparation dispatch is best-effort; the existing hourly background-job sweep remains the durable recovery mechanism — no new cron was introduced.
- Marketing Tags were introduced as normalized Product-related data (`marketing_tags`/`product_marketing_tags`), a distinct concept from Category, Collection, and SEO keywords.
- Initial price may be populated from the existing AI Intake proposal's suggested price only when the Product has no price yet — never a new AI provider call made solely for pricing.
- AI sales enrichment (Marketing Tags / price initialization) is best-effort and is not a core COD-launch dependency — its provider defaults to a safe local Mock (no network call, no API key) when unconfigured.

### Dependencies Introduced or Changed

- New tables: `marketing_tags`, `product_marketing_tags`. New provider-selection variable `SALES_ENRICHMENT_PROVIDER` (optional, defaults to Mock).

## Sprint 139 — Pending Publish Queue

### Architectural Decisions

- Pending Publish became a genuine Stock-Acceptance-provenance-based operational queue, not a plain `Product.status === "approved"` filter.
- `ai_product_intakes.appliedAt IS NOT NULL`, joined via the unique `resultProductId` relation, is the acceptance-provenance authority.
- This sprint did not yet exclude Products with historical channel-publish evidence from the queue — that gap was identified and closed later by Sprint 142.

## Sprint 138 — Warehouse Smoke Hardening

### Architectural Decisions

- An omitted warehouse-intake quantity now defaults to `1` rather than `0`, so Stock Acceptance and AI Intake Apply never silently create an accepted, unsellable zero-stock Product.

## Sprint 137 — Warehouse Intake & Barcode Workflow

### Architectural Decisions

- `Product.priceEur` became nullable, so Stock Acceptance may create a Product/Inventory row before a price is known.
- Sequential SKU remains the canonical Product identifier; the Code128 barcode payload remains the Product SKU itself.
- The warehouse label workflow (barcode rendering/reprint) reached its current architecture.
- Noctella Web publication (`validatePublish`) remains the point at which a valid storefront price is actually required — a nullable base price does not bypass that gate.
- Order-side price handling fails closed (`BadRequestError("Product has no valid price")`) rather than coercing a missing price to zero.

### Dependencies Introduced or Changed

- `products.price_eur` migrated to nullable (additive, idempotent, applied automatically via `ensureSchema()` — no manual migration step).

## Sprint 136 — Ready to Publish Operational Queue

### Architectural Decisions

- A Ready to Publish operational queue was introduced as an Admin-only operational surface — no backend/schema authority was created by this sprint.
- Its initial membership semantics (`Product.status === "approved"`) were later superseded by Sprint 139's Stock-Acceptance-provenance model; the operational route/page itself remained.

## Sprint 135 — Production Readiness Gate

### Architectural Decisions

- Production and staging are separate, independent Render Blueprints (`render.production.yaml` vs. the existing `render.yaml`). Production is never auto-deployed on a `main` commit (`autoDeployTrigger: off` on every production service); staging's own `autoDeployTrigger: checksPass` is unchanged. Sprint 135 completing does not constitute production authorization — that remains a separate, explicit human decision, documented in `docs/deployment/render-production.md`.
- `GET /ready` is a new, distinct, public, non-mutating business-readiness signal - separate from the existing `GET /health` process-liveness check, which is unchanged. `/ready` proves launch-critical *business* configuration (at least one active shipping method, public Stripe checkout disabled, mock payments disabled, Admin/Storefront origins configured), never process health. The response body exposes only booleans (`{status, checks: {...}}`) - never actual environment values, shipping-method labels/countries/profiles/rates, or database internals.
- The Sprint 134 zero-row shipping bootstrap-compatibility behavior (`allMethods.length===0` → legacy free shipping) is deliberately unchanged - it remains the correct behavior for the resolver itself (preserving ~25+ pre-existing test fixtures and any not-yet-configured deployment). `/ready` is the new, separate production-authorization gate that prevents that legacy compatibility state from ever being mistaken for launch-ready: zero shipping methods, or active-method-count zero (all inactive), both report `shippingConfigured: false` and an overall `503`.
- A narrow, route-specific rate limiter (`express-rate-limit`, new direct dependency of `apps/api`) protects only `POST /api/orders/cod` (5 requests per client per 10-minute window, in-memory store — no Redis/distributed store, consistent with the approved single-instance SQLite architecture). No other public route is rate-limited by this sprint. The existing Sprint 64B Admin-login rate limiter (durable, database-backed, by email and by IP) is unchanged and untouched.
- `app.set("trust proxy", 1)` - trusts exactly one reverse-proxy hop (Render's own edge), never the full `X-Forwarded-For` chain (`true` would let a client forge its own apparent IP). This is what makes `req.ip` resolve to the real client IP for the new COD rate limiter under the approved Render topology.
- The Admin Cash on Delivery settlement UI (`apps/admin/src/app/orders/[id]/page.tsx`) closes the one confirmed gap from Sprint 135's own supplemental Discovery: the `POST /orders/:id/settle-cod` backend (Sprint 132) was already correct and complete, but had no Admin web-application path to reach it. The new UI is visible only for a `cash_on_delivery` + `pending` order, submits an explicit, operator-visible `collectedAmount` (pre-filled with `Order.totalAmount` for convenience, never silently submitted), and reloads authoritative Order state from the server on success. The server's exact-cents equality check against `Order.totalAmount` remains the sole authority - no client-side monetary logic was added.
- The supplemental Discovery's auth/session finding stands unchanged by this sprint: the real Admin session mechanism (database-backed opaque bearer tokens, `crypto.randomBytes`-generated, SHA-256-hashed for storage; scrypt-hashed passwords with per-record random salts) uses no configurable secret at all. `JWT_SECRET`/`SESSION_SECRET` in `.env.example` remain accurately-labeled dead Sprint-1 scaffolding; no auth-related documentation or startup-validation change was needed.

### Dependencies Introduced or Changed

- New direct dependency: `express-rate-limit` (`apps/api/package.json`), used only by `apps/api/src/middleware/codRateLimit.ts`.
- New files: `apps/api/src/middleware/codRateLimit.ts`, `apps/api/src/use-cases/readiness/useCases.ts`, `apps/api/src/services/readiness.ts`, `render.production.yaml`, `docs/deployment/render-production.md`.
- No schema or migration change. No change to the shipping resolver, COD settlement backend, invoice/outbox architecture, or Stripe integration code.

### Technical Debt

- None introduced. Two pre-existing test files (`codOrderSprint129.test.ts`, `codSettlementSprint132.test.ts`) were updated to send distinct synthetic `X-Forwarded-For` values per logical test scenario, so their own many existing HTTP calls to the now-rate-limited `POST /api/orders/cod` are correctly treated as independent clients - matching real distinct customer traffic, not a weakening of the limiter.

### Deferred (explicitly out of scope)

- Rate limiting on any route other than `POST /api/orders/cod` (login already has its own durable limiter). CAPTCHA/WAF, Redis/distributed rate-limit infrastructure, a generic observability platform, request-correlation framework, PostgreSQL/multi-instance cutover, invoice PDF generation, double-entry accounting, weight-based shipping, carrier live rates, Local Pickup fulfillment wiring - all unchanged from Sprint 134's own deferral list.

### Entry Conditions

- Actual production provisioning, DNS configuration, environment-variable entry, and go-live authorization all remain separate, explicit, human-operator actions - see `docs/deployment/render-production.md`'s ordered checklist. No future sprint should assume any of these occurred merely because this Ledger entry exists.

## Sprint 134 — Storefront Launch Hardening / Shipping Domain

### Architectural Decisions

- Shipping is authoritative server-side only. A public, non-mutating quote endpoint (`POST /api/orders/shipping-options`) exists purely for storefront presentation; the client can never submit a price that becomes the charged amount. Final COD checkout independently re-resolves shipping inside the existing checkout transaction and fails closed on any mismatch (stale quote, deactivated method, or an ineligible selection).
- The launch shipping-rule vocabulary is intentionally minimal: `Free`, `FlatRate`, `FreeOverSubtotal` (`ShippingRuleType`). Weight tiers, postcode/zone rules, coupon-aware rules, and carrier-calculated live rates are explicitly deferred — not partially modeled, not stubbed with dead fields.
- `Order.shippingMethodId`/`shippingMethodLabel` form an immutable checkout-time snapshot, written once at Order creation and never rewritten by later `shipping_methods` configuration changes (label, rate, active-state edits). This snapshot is deliberately distinct from `Shipment.carrierCode`/logistics cost, which remains separate fulfillment-domain data untouched by this sprint.
- `countryCode` is the sole authority for country-based shipping eligibility, threaded additively through the existing `addressSchema` (optional, no new address table or migration). A missing/undefined `countryCode` only matches country-unrestricted shipping methods.
- The existing `products.shippingProfile` placeholder column is activated with a controlled vocabulary (`standard|free|paid|oversize`, `ProductShippingProfile`); `null`/unset means `standard`. A shipping method's `shippingProfiles` restriction (or `null` = unrestricted) must cover **every** distinct effective profile in the cart — never a hidden SUM/MAX/CHEAPEST combination rule across mixed-profile carts.
- Multiple eligible shipping methods are surfaced in deterministic `sortOrder` and never silently auto-resolved to "cheapest" or any other hidden precedence; the server auto-selects only when exactly one method is eligible (safe preselect), and fails closed (`BadRequestError`) when the client must choose but did not.
- Bootstrap/legacy compatibility: when zero `shipping_methods` rows have ever been created (active or not), checkout resolves the pre-Sprint-134 legacy zero-shipping behavior unchanged, rather than failing closed — this is deliberately distinguished from "shipping is configured but nothing matches this cart/destination," which does fail closed (`BadRequestError("No shipping method is available for this destination and cart")`).
- Shipping resolution is scoped strictly to the `codPending` path inside `finalizeInternalOrderInTransaction`. The Stripe/canonical `noctella_web` pricing-context path is explicitly untouched — Stripe's own subtotal-only paid-amount verification, computed at checkout-session creation before any Order exists, is disconnected from shipping, and extending shipping into that path would require redesigning Stripe checkout-session creation (explicitly out of scope).
- Product lookups for the shipping quote endpoint go through the canonical `OrderItemWriteRepository.validateProductReferences` repository method (the same one order creation itself uses), via a dedicated `getShippingOptionsUseCase` — never a direct DB query from the Service layer, preserving the Route → Service → UseCase → Repository boundary.
- A fail-closed, COD-only public Stripe checkout gate (`stripePublicCheckoutEnabled`) defaults to disabled regardless of `NODE_ENV`, checked before any Stripe-specific logic in `POST /api/payments/initialize`. Existing Stripe regression tests explicitly opt in via `STRIPE_PUBLIC_CHECKOUT_ENABLED=true`.
- Required address/customer string fields (`fullName`, `line1`, `city`, `postalCode`, `country`) are hardened with `.trim().min(1)` server-side; optional/free-text fields are unchanged.

### Dependencies Introduced or Changed

- New table `shipping_methods` (SQLite: full columns; PostgreSQL: stub-only `id` column, matching this schema file's established post-Sprint-24 stub convention for not-yet-fully-ported tables). New columns `orders.shipping_method_id`, `orders.shipping_method_label` (both files). New repository (`repositories/shipping`), Use Case module (`use-cases/shipping/useCases.ts`), Admin CRUD service/routes (`services/shippingMethods.ts`, `routes/shippingMethods.ts`, `settings.manage` permission, mirroring `routes/categories.ts`), and public quote route. `TransactionScopedRepositories` gained `shippingMethods`, wired identically to the Sprint 127 payments precedent.

### Technical Debt

- None introduced beyond the explicit deferrals below. `apps/api/src/db/schema.postgres.ts`'s pre-existing stub-only convention (several post-foundation tables have no real columns) is unchanged, matched, not fixed, by this sprint.

### Deferred (explicitly out of scope)

- Weight-based shipping tiers, postcode/zone-level rules, coupon-aware shipping rules, carrier live-rate integration, and Local Pickup fulfillment wiring (`CarrierCode.LocalPickup` remains a Shipment/fulfillment-domain concept only, unrelated to checkout shipping-method selection). Rate limiting on public mutation routes (identified in Discovery, no defect found in CORS configuration).

### Entry Conditions

- A follow-up sprint may introduce weight tiers or carrier-calculated rates as additive `ShippingRuleType` values without breaking the existing three; Local Pickup fulfillment wiring can reuse the existing `shippingProfiles`/`countryCodes` eligibility mechanism when scheduled.

## Sprint 133 — Invoice / Accounting Completion

### Architectural Decisions

- A settled Cash on Delivery order now enters the existing, already provider-neutral automatic Draft SalesInvoice pipeline — the same `SalesInvoiceDraftRequested` outbox mechanism Stripe-paid orders already use. No parallel COD-specific invoice queue, invoice model, or accounting authority was introduced.
- On a first-time (non-replay) successful COD settlement, the durable `SalesInvoiceDraftRequested` outbox intent is persisted via the existing `enqueueSalesInvoiceDraftForPaidOrderSync` helper, inside the same synchronous SQLite transaction as the guarded `Order.paymentStatus` Pending → Paid transition, the canonical `Payment` insert, and the canonical `PaymentEvent` insert. All four writes commit or roll back together — proven by a real forced-SQL-trigger test on the `outbox_events` insert.
- `settleCashOnDeliveryOrderUseCase` now accepts the same generic, domain-agnostic `PaidOrderOutboxPort` seam `finalizeInternalOrderInTransaction`/`updateOrderPaymentStatusUseCase` already use (Sprint 79's own established pattern) — the use case still never imports invoice-domain code directly; `services/orders.ts` supplies the real implementation.
- A coherent settlement replay never calls the outbox port — it returns from the existing replay-verification path before reaching the first-time-success branch, so a repeated identical settlement creates no second Payment, PaymentEvent, or outbox row.
- `services/orders.ts`'s `settleCashOnDeliveryOrder` adds the same existing-pattern best-effort immediate post-commit dispatch attempt (`dispatchDueSalesInvoiceOutboxEvents`, non-authoritative) already used by `updateOrderPaymentStatus`. The durable outbox row plus the existing scheduler/retry/dead-letter mechanism remains authoritative regardless of whether the immediate attempt succeeds.
- Eventual processing of the durable event, through the existing unmodified `OutboxDispatcher`/`CreateSalesInvoiceDraftHandler`, creates exactly one Draft `SalesInvoice`, using the existing immutable stored `OrderItem.productTitle` snapshot for invoice line titles (never the live `Product` title).
- No automatic invoice issuance and no automatic `financeEntries` row are created merely because a COD order settled and its Draft invoice was created — both remain tied to the existing explicit, manual invoice-issuance action, identical to Stripe-paid orders today.
- `Order.paymentReference` for COD remains unchanged (`null`) — no external provider transaction reference is fabricated.
- The existing generic Admin surfaces (`GET /orders/:id/invoice-status`, `POST /orders/:id/invoice-status/retry`) recognize the COD handoff without any new route; no schema migration was needed.
- Stripe's existing automatic Draft SalesInvoice behavior is unchanged — no Stripe-specific file was modified.

### Dependencies Introduced or Changed

- None. No runtime dependency, schema change, or migration. `settleCashOnDeliveryOrderUseCase` gained one optional `PaidOrderOutboxPort` parameter and one `outbox?.enqueue(...)` call in its existing first-time-success branch; `services/orders.ts`'s `settleCashOnDeliveryOrder` was wired to the existing `paidOrderOutbox` and gained one best-effort dispatch line. No document/PDF generation and no formal double-entry ledger exist in this system; none was added.

## Sprint 132 — COD Settlement / Reconciliation

### Architectural Decisions

- Cash on Delivery settlement is an explicit, authoritative Admin action (`POST /api/orders/:id/settle-cod`); it is never inferred from `ShipmentStatus.Delivered` or any other logistics signal, and settlement does not require Delivered — a Pending COD order with no shipment at all can be settled.
- The operator-provided `collectedAmount` is validated against the canonical `Order.totalAmount` using exact EUR-cents equality (`toEurCents`), with no epsilon, tolerance, or silent adjustment.
- The `Order.paymentStatus` Pending → Paid transition uses a single guarded, row-count-verified conditional update (`markPendingCashOnDeliveryOrderPaid`, `WHERE id=? AND payment_status='pending' AND payment_provider='cash_on_delivery'`), mirroring shipment-core's `markProcessingOrderShipped` (Sprint 131). The existing generic, unconditional `updateOrderPaymentStatusUseCase`/`updatePaymentStatus` is not reused for this competing-state transition.
- A successful first-time settlement atomically writes the guarded order transition, exactly one canonical `Payment` row (`provider=cash_on_delivery`, `status=paid`), and exactly one canonical `PaymentEvent` (`eventType=cod.settled`) in one synchronous SQLite transaction — reusing the existing, already-provider-neutral `TransactionPaymentRepository`/`TransactionPaymentEventRepository` (the same repositories Stripe uses) without any schema or repository-shape change.
- Settlement identity is deterministic (`cod-settlement:<orderId>`), reused as both `Payment.idempotencyKey` and the `PaymentEvent.(provider, providerEventId)` pair. A coherent replay (Order already Paid, with a matching canonical Payment + PaymentEvent and the same `collectedAmount`) is an idempotent no-op — no second Payment, no second PaymentEvent, no invoice enqueue. Any divergence (Paid order with missing/inconsistent canonical settlement state, or a mismatched replay amount) fails closed with a typed Conflict error; it is never auto-repaired.
- Settlement performs zero Inventory mutation (stock was already decremented at COD checkout acceptance, Sprint 129) and zero Shipment/Picking/Packing mutation — it remains technically independent of fulfillment state.
- Settlement never enqueues the `SalesInvoiceDraftRequested` outbox event; the new use case has no outbox parameter at all. Invoice/accounting completion remains Sprint 133.

### Dependencies Introduced or Changed

- None. No runtime dependency, schema change, or migration. One new guarded repository method (`OrderWriteRepository.markPendingCashOnDeliveryOrderPaid`) was added; existing Payment/PaymentEvent repository methods were reused unchanged.

## Sprint 131 — Shipping & Tracking Foundation

### Architectural Decisions

- Shipment creation requires a Processing order and exactly one unconsumed ReadyForShipment packing task; shipment quantities exactly match packing quantities and the existing packing `shipment_id` records the atomic handoff.
- One active shipment per order remains authoritative. Active shipments block canonical order cancellation before SaleRollback.
- Shipment InTransit and Order Shipped are persisted atomically; a marketplace submission job is inserted only by the successful joint transaction.
- Tracking remains required except for LocalPickup, and operator carrier/tracking identity edits are locked from InTransit onward. The manual label lifecycle is unchanged.
- Delivered, DeliveryFailed, and Returned remain logistics-only and leave the order Shipped, without Inventory, payment, invoice, or accounting effects. COD settlement remains Sprint 132; invoice/accounting completion remains Sprint 133; replacement shipment after Returned is deferred.

### Dependencies Introduced or Changed

- None. No runtime dependency, schema change, or migration.

## Sprint 130 — Fulfillment / Order Operations

### Capability Added

- Existing OrderStatus, picking, packing, and warehouse-event architecture is reused; `Processing` is the only picking-eligible order state.
- Picking and packing creation and actions enforce explicit transactional lifecycle guards.
- Canonical order cancellation rejects non-cancelled picking or packing work; task cancellation has no Inventory effect, and canonical order cancellation remains the sole pre-shipment Inventory restoration authority.

### Dependencies Introduced or Changed

- None. No runtime dependency, database schema, migration, new order status, or new fulfillment entity.

### Architectural Decisions

- Shipping, tracking, and shipment outcome behavior remain Sprint 131 scope.
- COD settlement and reconciliation remain Sprint 132 scope; fulfillment operations do not mutate payment state or create financial artifacts.

## Sprint 129 — Cash on Delivery Order Flow

### Capability Added

- Public COD checkout creates an immediately pending Noctella Web order with `cash_on_delivery`, atomically decrements authoritative inventory, and records canonical Sale stock movements.
- Server-authoritative Woo price/title fallback and product COD eligibility are evaluated inside the order transaction; stable `orderDraftId` provides replay idempotency.
- Canonical cancellation restoration now schedules stock synchronization only after commit.

### Dependencies Introduced or Changed

- Test-only Storefront devDependencies were added: `@testing-library/react`, `@testing-library/user-event`, `@vitejs/plugin-react`, and `jsdom`, reusing the established Admin test stack and versions.
- No runtime dependency, database schema, or migration change.

### Architectural Decisions

- COD acceptance creates no Payment, PaymentEvent, invoice, or paid-order outbox event and never marks the order paid.
- Stripe remains preserved and deferred; COD settlement and reconciliation require later architecture approval.

## Sprint 128 — Stripe Staging Operations Visibility & Runbook

### Capability Added

- Authenticated provider-agnostic operational payment detail with a safe event projection including explicit `providerEventId`.
- Minimal Admin payment detail and `manual_refund_required` operational guidance.
- A separately authorized Stripe staging-validation runbook.

### Dependencies Introduced or Changed

- None. No schema or migration change.

### Architectural Decisions

- The operational capability is read only: no provider mutation, automatic refund, or manual-refund acknowledgement state.
- Stripe activation and staging drills do not occur in this PR; external staging validation is post-merge and separately authorized.

### Deferred Work

- Operational Stripe test-mode activation, manual-refund reconciliation, Stripe refund adapter, refund accounting/CreditNote policy, and production activation.

## Sprint 127 — Stripe Checkout + Verified Payment Webhook

### Capability Added

- Hosted, card-only Stripe Checkout uses server-authoritative Noctella Web pricing and test-mode credentials only.
- Verified raw-body `checkout.session.completed` events with `payment_status=paid` are the sole real-Stripe fulfillment authority; live-mode events fail closed.
- Versioned durable checkout intent and frozen server-derived provider-request data preserve retry identity while current price and stock remain authoritative at webhook fulfillment.
- Checkout Session, PaymentIntent, and provider-event identities are durable and unique.
- Payment, event, order, inventory, stock movement, and paid-order invoice outbox completion share one atomic UnitOfWork; terminal stock/price failures use `manual_refund_required` without automatic refund.
- Public payment status and Storefront success/cancel flows are read only.

### Dependencies Introduced or Changed

- Official Stripe Node SDK in `apps/api`; no other dependency added.

### Architectural Decisions

- SQLite remains the deployed single-instance database; PostgreSQL changes are structural parity only.
- Real staging credentials are not configured, the Dashboard webhook is not registered, a real staging Checkout/webhook smoke test and manual-refund operational drill have not run, live mode is not activated, and production-readiness approval has not been granted.

### Validation

- Focused Stripe API: 5 files, 52 tests passed.
- Required API regressions: 10 files, 423 tests passed.
- Relevant Storefront: 6 files, 69 tests passed.
- API, Storefront, and Shared typecheck/build passed; Storefront lint passed.
- Architecture audit, repository parity, database parity, and final diff hygiene passed.

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

## Sprint 35N-P — Stock Aging Architecture Decision

### Capability

- No source code changed. This sprint records the architectural decision that closes the final Sprint 35E debt item.

### Architectural Decisions

- `stockAging()` in `apps/api/src/services/erpReportsAnalyticsBridge.ts` remains an intentional, dedicated cross-domain SQL query rather than being migrated into an existing or new repository.
- Current behavior preserved as documented: reads every product (no `LIMIT`, since complete catalog coverage is required for accurate bucket totals), ordered by SKU; derives the aging date from the earliest non-null `purchases.received_at` linked through `purchase_lines`, falling back to `products.created_at`; marks `source` as `"purchase/received/created"` when any linked `purchase_line` exists, otherwise `"created"`; preserves `stock_quantity`; performs age-bucket aggregation in application code; remains one indexed SQL query.
- Five options were evaluated: (A) `ProductReadRepository.stockAgingRows()`, (B) `InventoryRepository.stockAgingRows()`, (C) a Purchase-side read capability merged with Product-read data in the service layer, (D) a dedicated cross-domain ERP reporting read repository, (E) keep the existing dedicated query as a documented exception.
- Decision: Option E. The query is genuinely cross-domain (`products` joined against `purchases`/`purchase_lines`). `ProductReadRepository` currently has a product-only boundary with no coupling to Purchase schema. `InventoryRepository` is a protected transactional-integrity surface (atomicity, idempotency, optimistic concurrency), not a reporting surface. A new Purchase-read layer built for this single consumer would be disproportionate. A generic cross-domain reporting repository would be premature abstraction with only one real consumer today. The existing query is already set-based, indexed (`idx_purchase_lines_product`, `idx_purchases_dates`), non-N+1, and production-safe. Documenting the exception is preferable to forcing the query into a repository whose domain it does not belong to.
- `stockAging()` is not migrated into `ProductReadRepository`, `InventoryRepository`, a new `PurchaseReadRepository`, or a generic ERP reporting repository. The existing query is preserved until a broader reporting architecture need justifies a dedicated cross-domain reporting read layer.

### Technical Debt

- None introduced. Sprint 35E — Inventory Runtime Integration Audit is now fully closed: stock reconciliation, ERP inventory workspace reads, inventory aggregate summary, inventory report product list, export product list, and breakdown grouped aggregates were migrated to canonical repositories in prior sprints; `stockAging()` is closed by this explicit architectural decision rather than left as unreviewed debt.

### Entry Conditions

- None. A future sprint may revisit this decision if a broader cross-domain reporting architecture is introduced for other reasons.
