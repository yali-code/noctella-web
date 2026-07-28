import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { ErpInvoiceStatus, ErpInvoiceType, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder, cancelOrder, updateOrderPaymentStatus } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { upsertCompanyProfile } from "../src/services/companyProfile";
import { listInvoices } from "../src/services/erpSalesFinanceBridge";
import { OutboxEventStatus } from "../src/services/outbox";
import { dispatchDueSalesInvoiceOutboxEvents, getOrderInvoiceOutboxStatus, retrySalesInvoiceDraftForOrder, salesInvoiceDraftIdempotencyKey } from "../src/services/salesInvoiceOutbox";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
let seq = 0;
async function seedPaidOrder(db: any, opts: { quantity?: number } = {}) {
  seq += 1;
  const cat = await createCategory(db, { name: `Cat-${seq}`, displayOrder: 0, isActive: true });
  const product = await createProduct(db, { sku: `SKU-AUTO-${seq}`, title: `Product ${seq}`, slug: `product-auto-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 150, stockQuantity: opts.quantity ?? 1, images: [] });
  const ref = `auto-ref-${seq}`;
  await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: ref, status: PaymentStatus.Paid, amount: 150, currency: "EUR", idempotencyKey: `auto-pay-${seq}` });
  const order = await createOrder(db, { orderDraftId: `auto-draft-${seq}`, guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: ref, currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 150, totalAmount: 150, items: [{ productId: product.id, quantity: 1 as const }] });
  return { product, order };
}

describe("Sprint 79 automatic Sales Invoice Draft creation on order completion", () => {
  let db: any; let sqlite: Database.Database;
  beforeEach(async () => { const m = memoryDb(); db = m.db; sqlite = m.sqlite; await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 }); });

  it("a successful paid order creates exactly one Draft SalesInvoice, correctly linked to the order and its lines", async () => {
    const { order, product } = await seedPaidOrder(db);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);
    const invoice = invoices.items[0];
    expect(invoice.status).toBe(ErpInvoiceStatus.Draft);
    expect(invoice.invoiceType).toBe(ErpInvoiceType.SalesInvoice);
    expect(invoice.orderId).toBe(order.id);
    const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id));
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe(product.id);
    expect(lines[0].quantity).toBe(1);
  });

  it("does not create a second invoice under concurrent order-creation retries of the same idempotency key", async () => {
    // createOrder is itself idempotent on orderDraftId; a genuine duplicate submission of the same
    // draft must not multiply invoices, matching the order's own idempotent-replay guarantee.
    const { order: first } = await seedPaidOrder(db);
    const cat = await createCategory(db, { name: "Retry-cat", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-RETRY", title: "Retry product", slug: "retry-product", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 150, stockQuantity: 1, images: [] });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "retry-ref", status: PaymentStatus.Paid, amount: 150, currency: "EUR", idempotencyKey: "retry-pay" });
    const input = { orderDraftId: "retry-draft", guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "retry-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 150, totalAmount: 150, items: [{ productId: product.id, quantity: 1 as const }] };
    const [a, b] = await Promise.all([createOrder(db, input), createOrder(db, input)]);
    expect(a.id).toBe(b.id);
    expect((await listInvoices(db, { orderId: a.id })).items).toHaveLength(1);
    void first;
  });

  it("no duplicate SalesInvoice is created when a fresh createInvoiceDraft-equivalent retry targets an order that already has one (idempotent lookup-and-return)", async () => {
    const { order } = await seedPaidOrder(db);
    const { createAutomaticSalesInvoiceDraft } = await import("../src/services/erpSalesFinanceBridge");
    const again = await createAutomaticSalesInvoiceDraft(db, order.id);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0].id).toBe(again.id);
  });

  it("cancelling an order does not create an additional invoice, and the original Draft is untouched", async () => {
    const { order } = await seedPaidOrder(db);
    const before = await listInvoices(db, { orderId: order.id });
    await cancelOrder(db, order.id);
    const after = await listInvoices(db, { orderId: order.id });
    expect(after.items).toHaveLength(1);
    expect(after.items[0].id).toBe(before.items[0].id);
    expect(after.items[0].status).toBe(ErpInvoiceStatus.Draft);
  });

  it("automatic-creation failure does not roll back or otherwise corrupt the already-committed order/stock transaction (order remains fully valid even without an invoice)", async () => {
    // Simulate the invoice-creation handler failing by removing the invoices table entirely before
    // order creation runs. The durable outbox event is enqueued in the SAME transaction as the
    // order/stock write (a separate table, unaffected by invoices being renamed away), so that
    // enqueue always succeeds; only the handler's later attempt to INSERT into invoices fails. That
    // failure is caught and recorded by the outbox dispatcher (RetryPending/DeadLetter), never
    // propagated back to createOrder - proving the order/stock transaction is fully independent of
    // invoice-creation success, while the failure itself remains durably recorded rather than lost
    // (see the outbox dead-letter/retry test below).
    sqlite.exec("ALTER TABLE invoices RENAME TO invoices_disabled");
    try {
      const { order, product } = await seedPaidOrder(db);
      expect(order.id).toBeTruthy();
      const [reloadedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
      expect(reloadedProduct.stockQuantity).toBe(0);
      expect(reloadedProduct.status).toBe(ProductStatus.Sold);
    } finally {
      sqlite.exec("ALTER TABLE invoices_disabled RENAME TO invoices");
    }
  });
});

describe("Sprint 79 correction: durable outbox event lifecycle for automatic Sales Invoice Drafts", () => {
  let db: any; let sqlite: Database.Database;
  beforeEach(async () => { const m = memoryDb(); db = m.db; sqlite = m.sqlite; await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 }); });

  async function eventFor(orderId: string) {
    const [event] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, salesInvoiceDraftIdempotencyKey(orderId)));
    return event;
  }

  it("a successful paid order leaves exactly one Succeeded durable event, and re-dispatching it creates no duplicate", async () => {
    const { order } = await seedPaidOrder(db);
    const event = await eventFor(order.id);
    expect(event.status).toBe(OutboxEventStatus.Succeeded);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("Created");
  });

  it("a transient invoice-creation failure leaves the order fully valid, keeps the event retryable, and a later scheduler tick creates the invoice with no silent loss", async () => {
    sqlite.exec("ALTER TABLE invoices RENAME TO invoices_disabled");
    const { order, product } = await seedPaidOrder(db);
    sqlite.exec("ALTER TABLE invoices_disabled RENAME TO invoices");

    const failedEvent = await eventFor(order.id);
    expect([OutboxEventStatus.RetryPending, OutboxEventStatus.Pending]).toContain(failedEvent.status);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);
    const [productAfterFailure] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(productAfterFailure.stockQuantity).toBe(0);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).not.toBe("Created");

    // Simulate the next scheduler tick after the retry backoff has elapsed.
    await db.update(schema.outboxEvents).set({ availableAt: new Date().toISOString() }).where(eq(schema.outboxEvents.id, failedEvent.id));
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);

    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("Created");
  });

  it("exhausting all retry attempts dead-letters the event, the Admin status reflects it, and the authorized retry action reactivates and durably succeeds", async () => {
    sqlite.exec("ALTER TABLE invoices RENAME TO invoices_disabled");
    const { order } = await seedPaidOrder(db);

    for (let i = 0; i < 6; i++) {
      const event = await eventFor(order.id);
      if (event.status === OutboxEventStatus.DeadLetter) break;
      await db.update(schema.outboxEvents).set({ availableAt: new Date().toISOString() }).where(eq(schema.outboxEvents.id, event.id));
      await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    }
    const deadLetteredEvent = await eventFor(order.id);
    expect(deadLetteredEvent.status).toBe(OutboxEventStatus.DeadLetter);

    // getOrderInvoiceOutboxStatus/listInvoices both query the invoices table, which is still
    // renamed away at this point - restore it before reading through either of them.
    sqlite.exec("ALTER TABLE invoices_disabled RENAME TO invoices");

    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("FailedDeadLettered");
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);

    // The authorized retry re-enqueues/reactivates the SAME durable event - it never inserts an invoice directly.
    const retryResult = await retrySalesInvoiceDraftForOrder(db, order.id);
    expect(retryResult).toEqual({ retried: true, reason: "Reactivated" });
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);

    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("Created");

    // Retrying again once an invoice already exists is reported, not repeated.
    const noopRetry = await retrySalesInvoiceDraftForOrder(db, order.id);
    expect(noopRetry.retried).toBe(false);
    expect(noopRetry.reason).toBe("AlreadyCreated");
  });

  it("marketplace-imported orders receive no outbox event at all - not even a Succeeded or dead-lettered one - and no automatic invoice", async () => {
    // Mirrors services/marketplaceSync.ts's actual call: createOrder(db, {...}, { enqueueInvoiceDraft: false })
    // followed by linking a marketplace_orders row to the created internal order.
    const cat = await createCategory(db, { name: "MP-cat", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-MP-1", title: "MP product", slug: "mp-product-1", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 150, stockQuantity: 1, images: [] });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "mp-ref-1", status: PaymentStatus.Paid, amount: 150, currency: "EUR", idempotencyKey: "mp-pay-1" });
    const order = await createOrder(db, { orderDraftId: "mp-draft-1", guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "mp-ref-1", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 150, totalAmount: 150, items: [{ productId: product.id, quantity: 1 as const }] }, { enqueueInvoiceDraft: false });
    const now = new Date().toISOString();
    await db.insert(schema.marketplaceConnections).values({ id: "mp-conn-1", channel: "eBay", accountLabel: "Test", status: "connected", createdAt: now, updatedAt: now });
    await db.insert(schema.marketplaceOrders).values({ id: "mp-order-1", channel: "eBay", externalOrderId: "ext-1", marketplaceConnectionId: "mp-conn-1", internalOrderId: order.id, status: "paid", importStatus: "imported", currency: "EUR", subtotal: 150, shipping: 0, tax: 0, total: 150, rawPayloadSnapshot: "{}", orderedAt: now, importedAt: now, updatedAt: now });

    expect(await eventFor(order.id)).toBeUndefined();
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("NotApplicableMarketplace");
    // A retry attempt correctly refuses rather than creating an event for an excluded order.
    await expect(retrySalesInvoiceDraftForOrder(db, order.id)).rejects.toThrow(/Marketplace-imported orders/);
  });

  it("an accepted-offer order that starts unpaid has no invoice; only the Paid transition enqueues the durable event, and repeating the Paid transition creates no duplicate", async () => {
    // createOrder always requires an already-Paid payment session and always stores the resulting
    // order as Paid (see services/orders.ts) - there is currently no public order-creation path
    // that produces a genuinely unpaid order. To exercise updateOrderPaymentStatusUseCase's
    // not-already-Paid -> Paid transition (the forward-compatible hook point for an accepted-offer
    // order becoming Paid after creation), a Paid order is created normally and then reset to
    // Pending directly, undoing its auto-created event/invoice - simulating the pre-transition state.
    const { order } = await seedPaidOrder(db);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.orderId, order.id));
    await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id));
    await db.delete(schema.invoiceEvents).where(eq(schema.invoiceEvents.invoiceId, invoice.id));
    await db.delete(schema.invoices).where(eq(schema.invoices.id, invoice.id));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, salesInvoiceDraftIdempotencyKey(order.id)));
    await db.update(schema.orders).set({ paymentStatus: PaymentStatus.Pending }).where(eq(schema.orders.id, order.id));

    expect(await eventFor(order.id)).toBeUndefined();
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("NoInvoiceUnpaid");

    await updateOrderPaymentStatus(db, order.id, { paymentStatus: PaymentStatus.Paid });
    expect(await eventFor(order.id)).toBeTruthy();
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);

    // Repeating the same Paid transition (already Paid -> Paid) must not enqueue a second event or invoice.
    await updateOrderPaymentStatus(db, order.id, { paymentStatus: PaymentStatus.Paid });
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
  });
});
