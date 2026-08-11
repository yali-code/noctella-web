import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { ErpInvoiceStatus, ErpInvoiceType, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct, updateProduct } from "../src/services/products";
import { upsertCompanyProfile } from "../src/services/companyProfile";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createCashOnDeliveryOrderUseCase, settleCashOnDeliveryOrderUseCase } from "../src/use-cases/order/useCases";
import { listInvoices } from "../src/services/erpSalesFinanceBridge";
import { dispatchDueSalesInvoiceOutboxEvents, enqueueSalesInvoiceDraftForPaidOrderSync, getOrderInvoiceOutboxStatus, salesInvoiceDraftIdempotencyKey } from "../src/services/salesInvoiceOutbox";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
const address = { fullName: "COD Buyer", line1: "1 Sofia Street", city: "Sofia", postalCode: "1000", country: "BG" };
/** Same generic PaidOrderOutboxPort wiring services/orders.ts's real settleCashOnDeliveryOrder uses. */
const codOutbox = { enqueue: (tx: any, orderId: string) => enqueueSalesInvoiceDraftForPaidOrderSync(tx, orderId) };

describe("Sprint 133 COD settlement -> automatic Draft SalesInvoice handoff", () => {
  let db: any; let sqlite: Database.Database; let seq = 0;

  beforeEach(async () => {
    const m = memoryDb(); db = m.db; sqlite = m.sqlite;
    await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 });
  });

  async function seedPendingCodOrder(overrides: Record<string, unknown> = {}) {
    seq += 1;
    const cat = await createCategory(db, { name: `Cat-133-${seq}`, displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: `SKU-COD133-${seq}`, title: `COD Product ${seq}`, wooProductName: `Web COD Product ${seq}`, slug: `cod133-product-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, priceEur: 150, wooListingPriceEur: 150, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false, ...overrides });
    const order = await createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute({ orderDraftId: `cod133-draft-${seq}`, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] });
    return { product, order };
  }

  function settle(orderId: string, collectedAmount: number) {
    return settleCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db), codOutbox).execute({ orderId, collectedAmount });
  }

  it("1. a first successful settlement becomes Paid and atomically creates exactly one Payment, one PaymentEvent, and one durable invoice-draft outbox intent", async () => {
    const { order } = await seedPendingCodOrder();
    const result = await settle(order.id, order.totalAmount);
    expect(result.replay).toBe(false);
    expect(result.order.paymentStatus).toBe(PaymentStatus.Paid);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(1);
    expect(await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.paymentId, result.paymentId))).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id))).toHaveLength(1);
  });

  it("2. the durable outbox intent matches the exact existing SalesInvoiceDraftRequested contract", async () => {
    const { order } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    const [event] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id));
    expect(event.eventType).toBe("sales_invoice.draft_requested");
    expect(event.aggregateType).toBe("Order");
    expect(event.idempotencyKey).toBe(salesInvoiceDraftIdempotencyKey(order.id));
    expect(JSON.parse(event.payload)).toEqual({ orderId: order.id });
  });

  it("3. a coherent identical replay creates no second Payment, PaymentEvent, or outbox row", async () => {
    const { order } = await seedPendingCodOrder();
    const first = await settle(order.id, order.totalAmount);
    const second = await settle(order.id, order.totalAmount);
    expect(second.replay).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(1);
    expect(await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.paymentId, first.paymentId))).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id))).toHaveLength(1);
  });

  it("4. processing the durable event through the real dispatcher/handler creates exactly one Draft SalesInvoice, correctly linked", async () => {
    const { order, product } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0].status).toBe(ErpInvoiceStatus.Draft);
    expect(invoices.items[0].invoiceType).toBe(ErpInvoiceType.SalesInvoice);
    const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoices.items[0].id));
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe(product.id);
  });

  it("5. repeated dispatch/retry of the same durable event does not create a second SalesInvoice", async () => {
    const { order } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
  });

  it("6. the Draft invoice line title uses the immutable stored OrderItem snapshot, not a live Product title changed after order creation", async () => {
    const { order, product } = await seedPendingCodOrder({ wooProductName: "Original COD Title" });
    expect(order.items[0]).toMatchObject({ productTitle: "Original COD Title" });
    await updateProduct(db, product.id, { wooProductName: "Renamed After Settlement" });
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    const invoices = await listInvoices(db, { orderId: order.id });
    const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoices.items[0].id));
    expect(lines[0].titleSnapshot).toBe("Original COD Title");
  });

  it("7. automatic processing creates a Draft only - it never issues the invoice", async () => {
    const { order } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items[0].status).toBe(ErpInvoiceStatus.Draft);
    expect(invoices.items[0].invoiceNumber).toBeNull();
    expect(invoices.items[0].issuedAt).toBeNull();
  });

  it("8. no financeEntries row is created merely from COD settlement plus automatic Draft invoice creation", async () => {
    const { order } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    expect(await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.orderId, order.id))).toHaveLength(0);
  });

  it("9. settlement plus the invoice handoff perform no second inventory mutation", async () => {
    const { order, product } = await seedPendingCodOrder();
    const stockBefore = (await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity;
    const movementsBefore = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).length;
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    const stockAfter = (await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity;
    const movementsAfter = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).length;
    expect(stockAfter).toBe(stockBefore);
    expect(movementsAfter).toBe(movementsBefore);
  });

  it("10. settlement plus the invoice handoff never touch shipment, picking, or packing", async () => {
    const { order } = await seedPendingCodOrder();
    await settle(order.id, order.totalAmount);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    expect(await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.pickingTasks).where(eq(schema.pickingTasks.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.orderId, order.id))).toHaveLength(0);
  });

  it("11. a forced failure on the outbox-intent insert rolls back the entire first-time settlement transaction (Order, Payment, PaymentEvent, and the outbox row together)", async () => {
    const { order } = await seedPendingCodOrder();
    sqlite.exec("CREATE TRIGGER sprint133_fail_outbox_insert BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'sales_invoice.draft_requested' BEGIN SELECT RAISE(ABORT, 'forced Sprint 133 outbox failure'); END");
    try {
      await expect(settle(order.id, order.totalAmount)).rejects.toThrow(/forced Sprint 133 outbox failure/);
    } finally {
      sqlite.exec("DROP TRIGGER sprint133_fail_outbox_insert");
    }
    const fresh = (await db.select().from(schema.orders).where(eq(schema.orders.id, order.id)))[0];
    expect(fresh.paymentStatus).toBe(PaymentStatus.Pending);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.paymentEvents)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id))).toHaveLength(0);
  });

  it("12. the existing generic Admin invoice-status surface recognizes the COD handoff end-to-end without a new route", async () => {
    const { order } = await seedPendingCodOrder();
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("NoInvoiceUnpaid");
    await settle(order.id, order.totalAmount);
    expect((await getOrderInvoiceOutboxStatus(db, order.id)).state).toBe("Pending");
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);
    const status = await getOrderInvoiceOutboxStatus(db, order.id);
    expect(status.state).toBe("Created");
    expect(status.invoiceId).toBeTruthy();
  });
});
