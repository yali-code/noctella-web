import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { invoices, marketplaceOrders, orders, outboxEvents } from "../db/schema";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType, safeOutboxError, type OutboxEvent, type OutboxHandler } from "./outbox";
import { PostgresOutboxRepository, SqliteOutboxRepository } from "./outboxRepository";
import { createAutomaticSalesInvoiceDraft } from "./erpSalesFinanceBridge";
import { BadRequestError, NotFoundError } from "./errors";
import { ErpInvoiceType, PaymentStatus } from "@noctella/shared";

/**
 * Sprint 79 correction: replaces the removed inline best-effort call in services/orders.ts.
 * One durable event per order (idempotency-key-scoped), retried/dead-lettered through the same
 * generic OutboxDispatcher already proven for product-photo processing — never a silent,
 * unrecoverable failure.
 */
export function salesInvoiceDraftIdempotencyKey(orderId: string) {
  return `sales-invoice-draft:${orderId}`;
}

/**
 * Synchronous enqueue for use *inside* a better-sqlite3 transaction callback (the same
 * transaction that establishes the paid order state) — never awaited there. Check-then-insert on
 * the idempotency key (matching this codebase's established idempotency convention, e.g.
 * financePostings.ts's createFinanceEntrySync) rather than catch-and-ignore, so a replayed order
 * creation never inserts a second event for the same order.
 */
export function enqueueSalesInvoiceDraftForPaidOrderSync(tx: DbClient, orderId: string) {
  const key = salesInvoiceDraftIdempotencyKey(orderId);
  const existing = (tx.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, key)).limit(1) as unknown as { get(): unknown }).get();
  if (existing) return;
  const now = new Date().toISOString();
  (tx.insert(outboxEvents).values({
    id: randomUUID(), eventType: OutboxEventType.SalesInvoiceDraftRequested, aggregateType: "Order", aggregateId: orderId,
    idempotencyKey: key, payload: JSON.stringify({ orderId }), status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 5,
    availableAt: now, createdAt: now, updatedAt: now,
  }) as unknown as { run(): void }).run();
}

/** Async sibling for contexts that are not already inside a synchronous transaction (e.g. an Admin-triggered retry). */
export async function enqueueSalesInvoiceDraftForPaidOrder(db: DbClient, orderId: string) {
  const key = salesInvoiceDraftIdempotencyKey(orderId);
  const [existing] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, key)).limit(1);
  if (existing) return existing;
  const now = new Date().toISOString();
  const row = { id: randomUUID(), eventType: OutboxEventType.SalesInvoiceDraftRequested, aggregateType: "Order", aggregateId: orderId, idempotencyKey: key, payload: JSON.stringify({ orderId }), status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 5, availableAt: now, createdAt: now, updatedAt: now };
  await db.insert(outboxEvents).values(row);
  return row;
}

/**
 * Explicit, non-fragile permanent-vs-retryable distinction: NotEligible marks the underlying
 * error `permanent` so OutboxDispatcher dead-letters it immediately instead of burning retry
 * attempts on a condition that will never change (e.g. a cancelled order, or a marketplace-
 * imported order an event was mistakenly enqueued for).
 */
class NotEligibleError extends Error { permanent = true; constructor(message: string) { super(message); this.name = "NotEligibleError"; } }

export class CreateSalesInvoiceDraftHandler implements OutboxHandler {
  eventType = OutboxEventType.SalesInvoiceDraftRequested;
  constructor(private readonly db: DbClient) {}
  async handle(event: OutboxEvent) {
    const orderId = String((event.payload as any).orderId ?? event.aggregateId ?? "");
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotEligibleError("Order not found");
    if (order.paymentStatus !== PaymentStatus.Paid) throw new NotEligibleError("Order is not Paid");
    if (order.currency !== "EUR") throw new NotEligibleError("Order currency is not EUR");
    // Marketplace exclusion is an intentional policy skip, not an error condition: unlike the
    // NotEligibleError cases above (which flag a genuine data inconsistency worth an admin's
    // attention via DeadLetter), a marketplace-imported order reaching this handler is expected
    // and correct - it returns normally so the dispatcher records the event as Succeeded, never
    // as a failed attempt or a dead letter. (getOrderInvoiceOutboxStatus reports this order's
    // state as NotApplicableMarketplace independently of the event's own status either way.)
    const [marketplaceLink] = await this.db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)).limit(1);
    if (marketplaceLink) return;
    await createAutomaticSalesInvoiceDraft(this.db, orderId);
  }
}

export function createSalesInvoiceOutboxDispatcher(db: DbClient, driver: "sqlite" | "postgres" | "supabase-postgres" = (process.env.DATABASE_DRIVER as any) || "sqlite"): OutboxDispatcher {
  const isPostgres = driver === "postgres" || driver === "supabase-postgres";
  const repo = isPostgres
    ? new PostgresOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof PostgresOutboxRepository>[0] }).$client)
    : new SqliteOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof SqliteOutboxRepository>[0] }).$client);
  const dispatcher = new OutboxDispatcher(repo);
  dispatcher.registerHandler(new CreateSalesInvoiceDraftHandler(db));
  return dispatcher;
}

/** Same 5-minute stale-lock threshold as the product-photo dispatcher — see PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS for the rationale (far longer than any real handler run, far shorter than the hourly scheduler cadence). */
export const SALES_INVOICE_OUTBOX_STALE_LOCK_MS = 5 * 60 * 1000;

export async function dispatchDueSalesInvoiceOutboxEvents(db: DbClient, workerId = "scheduler", limit = 10) {
  const dispatcher = createSalesInvoiceOutboxDispatcher(db);
  await dispatcher.releaseStaleLocks(SALES_INVOICE_OUTBOX_STALE_LOCK_MS);
  return dispatcher.dispatchDueEvents(workerId, limit);
}

/** Never logs order snapshot contents (addresses, payment references) — only the order id and the dispatcher's own already-redacted safe error code/message (see outbox.ts's safeOutboxError). */
export function safeSalesInvoiceOutboxLogMetadata(orderId: string, error: unknown) {
  const safe = safeOutboxError(error);
  return { orderId, safeErrorCode: safe.code, safeErrorMessage: safe.message };
}

export type OrderInvoiceOutboxState = "Created" | "Pending" | "Retrying" | "FailedDeadLettered" | "NotApplicableMarketplace" | "NoInvoiceUnpaid";

/**
 * Sprint 79 requirement #4: minimal, read-only status for the Admin Order detail page — never
 * exposes outbox internals (payload, lock owner) beyond the attempt count and the dispatcher's
 * own already-redacted safe error message.
 */
export async function getOrderInvoiceOutboxStatus(db: DbClient, orderId: string): Promise<{ state: OrderInvoiceOutboxState; invoiceId?: string; attemptCount?: number; lastErrorMessage?: string | null }> {
  const [existingInvoice] = await db.select().from(invoices).where(and(eq(invoices.orderId, orderId), eq(invoices.invoiceType, ErpInvoiceType.SalesInvoice))).limit(1);
  if (existingInvoice) return { state: "Created", invoiceId: existingInvoice.id };
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new NotFoundError("Order not found");
  const [marketplaceLink] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)).limit(1);
  if (marketplaceLink) return { state: "NotApplicableMarketplace" };
  if (order.paymentStatus !== PaymentStatus.Paid) return { state: "NoInvoiceUnpaid" };
  const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, salesInvoiceDraftIdempotencyKey(orderId))).limit(1);
  // A Paid, eligible order with no event row yet is reported as Pending, not NoInvoiceUnpaid — it
  // is genuinely eligible (either the post-commit dispatch attempt hasn't landed yet, or this is a
  // pre-Sprint-79 historical order that predates the enqueue-on-payment wiring); the retry action
  // enqueues a fresh event for exactly this case rather than requiring the order to be unpaid/paid
  // again to become eligible.
  if (!event) return { state: "Pending" };
  if (event.status === OutboxEventStatus.DeadLetter || event.status === OutboxEventStatus.Failed) return { state: "FailedDeadLettered", attemptCount: event.attemptCount, lastErrorMessage: event.lastErrorMessage };
  if (event.status === OutboxEventStatus.RetryPending) return { state: "Retrying", attemptCount: event.attemptCount, lastErrorMessage: event.lastErrorMessage };
  return { state: "Pending", attemptCount: event.attemptCount };
}

/**
 * Sprint 79 requirement #4: authorized retry action — never bypasses the outbox by calling
 * createAutomaticSalesInvoiceDraft directly. A DeadLetter/Failed event is reactivated in place
 * (attemptCount reset so it gets a full fresh retry budget, since an admin retry implies the
 * underlying condition — e.g. a missing company profile — may since have been fixed); a
 * still-in-flight event (Pending/Processing/RetryPending) is left untouched and reported as such
 * rather than duplicated; an order that already has an invoice, is not Paid, or is
 * marketplace-imported is rejected rather than silently creating a new event.
 */
export async function retrySalesInvoiceDraftForOrder(db: DbClient, orderId: string) {
  const [existingInvoice] = await db.select().from(invoices).where(and(eq(invoices.orderId, orderId), eq(invoices.invoiceType, ErpInvoiceType.SalesInvoice))).limit(1);
  if (existingInvoice) return { retried: false, reason: "AlreadyCreated" as const, invoiceId: existingInvoice.id };
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new NotFoundError("Order not found");
  if (order.paymentStatus !== PaymentStatus.Paid) throw new BadRequestError("Order is not Paid; automatic invoicing is not applicable");
  const [marketplaceLink] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)).limit(1);
  if (marketplaceLink) throw new BadRequestError("Marketplace-imported orders are excluded from automatic invoicing in this sprint");
  const key = salesInvoiceDraftIdempotencyKey(orderId);
  const [existingEvent] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, key)).limit(1);
  const now = new Date().toISOString();
  if (!existingEvent) {
    await enqueueSalesInvoiceDraftForPaidOrder(db, orderId);
    return { retried: true, reason: "Enqueued" as const };
  }
  if (existingEvent.status !== OutboxEventStatus.DeadLetter && existingEvent.status !== OutboxEventStatus.Failed) {
    return { retried: false, reason: "AlreadyInProgress" as const, status: existingEvent.status };
  }
  await db.update(outboxEvents).set({ status: OutboxEventStatus.Pending, attemptCount: 0, availableAt: now, lockedAt: null, lockedBy: null, lastErrorCode: null, lastErrorMessage: null, deadLetteredAt: null, updatedAt: now }).where(eq(outboxEvents.id, existingEvent.id));
  return { retried: true, reason: "Reactivated" as const };
}
