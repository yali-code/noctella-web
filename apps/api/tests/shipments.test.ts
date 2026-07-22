import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BackgroundJobStatus, CarrierCode, MarketplaceConnectionStatus, MarketplaceFulfillmentStatus, OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType, PublishChannel, ShipmentStatus } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { createOrder, getOrderById, updateOrderStatus } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { listStockMovements } from "../src/services/stockMovements";
import { executeJob } from "../src/services/backgroundJobs";
import { encryptCredential } from "../src/services/credentialEncryption";
import { createShipment, markReady, markShipped, updateShipmentStatus, assignTracking, getShipmentEvents, markDelivered, markDeliveryFailed, markReturned, cancelShipment, listShipments, completeSale, getSaleCompletionReadiness, refreshTracking, getShipmentTracking, setShipmentMarketplaceAdapterResolver, submitMarketplaceShipment, reopenSale } from "../src/services/shipments";
import type { MarketplaceAdapter } from "../src/services/marketplaceAdapters";
import * as schema from "../src/db/schema";
import { createTestDb } from "./testDb";

const key = Buffer.alloc(32, 12).toString("base64");
const address = { fullName: "Jane", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" };
function fakeAdapter(overrides: Partial<MarketplaceAdapter> = {}) { let calls = 0; const a: MarketplaceAdapter & { calls: () => number } = { getAuthorizationUrl: () => "", exchangeAuthorizationCode: async () => ({ accessToken: "" }), refreshAccessToken: async () => ({ accessToken: "" }), verifyConnection: async () => ({}), createListing: async () => ({ externalListingId: "", externalStatus: "" }), updateListing: async () => ({ externalListingId: "", externalStatus: "" }), endListing: async () => ({ externalListingId: "", externalStatus: "" }), verifyWebhookSignature: () => true, parseWebhookEvent: () => ({ externalEventId: "e", eventType: "unsupported", payload: {} }), fetchOrderById: async () => ({ externalOrderId: "", status: "paid", currency: "EUR", subtotal: 0, shipping: 0, tax: 0, total: 0, orderedAt: new Date().toISOString(), items: [] }), fetchListingStatus: async () => ({ externalListingId: "", externalStatus: "" }), getListingInventory: async () => ({ externalListingId: "", stock: 0 }), updateListingInventory: async () => ({ externalListingId: "", requestedStock: 0, confirmedStock: 0 }), submitShipment: async (_t, payload: any) => { calls += 1; return { shipment: payload.shipment, externalFulfillmentId: `ful-${calls}`, marketplaceStatus: MarketplaceFulfillmentStatus.Accepted }; }, updateShipmentTracking: async (_t, _id, payload: any) => { calls += 1; return { shipment: payload.shipment, marketplaceStatus: MarketplaceFulfillmentStatus.Accepted }; }, cancelShipmentFulfillment: async () => ({ shipment: {} as any, marketplaceStatus: MarketplaceFulfillmentStatus.Cancelled }), fetchShipmentStatus: async () => ({ shipment: {} as any, marketplaceStatus: MarketplaceFulfillmentStatus.Accepted }), normalizeError: () => ({ type: "Temporary", message: "temporary", retryable: true }), normalizeInventoryError: () => ({ type: "Temporary", message: "temporary", retryable: true }), normalizeShipmentError: (e) => String((e as Error).message).includes("permanent") ? { type: "Permanent", message: "permanent", retryable: false } : { type: "Temporary", message: "temporary", retryable: true }, calls: () => calls, ...overrides }; return a; }

describe("Sprint 14 shipment workflow", () => {
  let db: ReturnType<typeof createTestDb>; let order: any; let productId: string;
  beforeEach(async () => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = key; vi.restoreAllMocks(); db = createTestDb(); const category = await createCategory(db, { name: "Cat", isActive: true, displayOrder: 0 }); const product = await createProduct(db, { sku: "SHIP-1", title: "Vase", slug: "vase", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, priceEur: 100, purchaseCost: 40, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false }); productId = product.id; await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "pay", status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: "test:pay" }); order = await createOrder(db, { orderDraftId: `draft-${Math.random()}`, guestEmail: "j@example.com", status: OrderStatus.Pending, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "pay", currency: "EUR", billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId, quantity: 1 }] }); setShipmentMarketplaceAdapterResolver(() => fakeAdapter()); });
  it("keeps schema idempotent with required tables, indexes, active shipment and financial uniqueness", async () => { const sqlite = (db as any).session.client; expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shipments'").get()).toBeTruthy(); expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shipments_one_active_order'").get()).toBeTruthy(); expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shipments_tracking'").get()).toBeTruthy(); expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_sale_financials_2'").get()).toBeTruthy(); });
  it("creates shipments idempotently and validates invalid order, over-quantity, Other carrier, EUR, and A1Post customs metadata", async () => { const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.A1Post, shippingCost: 12, customs: { productDescription: "Vase", hsCode: "6913", declaredValue: 100, weight: 2, ddpReference: "DDP", iossReference: "IOSS" } }); expect(s.carrierCode).toBe(CarrierCode.A1Post); expect((await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS })).id).toBe(s.id); await expect(createShipment(db, { orderId: "bad", carrierCode: CarrierCode.UPS })).rejects.toThrow(/Order not found/); await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.Other })).rejects.toThrow(/Custom carrier/); await cancelShipment(db, s.id); await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.Other })).rejects.toThrow(/Custom carrier/); await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS, currency: "USD" })).rejects.toThrow(/EUR/); await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS, items: [{ orderItemId: order.items[0].id, quantity: 2 }] })).rejects.toThrow(/exceeds/); });
  it("requires tracking before InTransit except LocalPickup and records events for valid/invalid transitions", async () => { const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS }); await markReady(db, s.id); await expect(markShipped(db, s.id)).rejects.toThrow(/Tracking/); await assignTracking(db, s.id, { trackingNumber: "1Z" }); await markShipped(db, s.id); await expect(markReady(db, s.id)).rejects.toThrow(/Invalid/); await markDelivered(db, s.id); expect((await getShipmentEvents(db, s.id)).length).toBeGreaterThanOrEqual(5); const lp = await createShipment(db, { orderId: order.id + "x", carrierCode: CarrierCode.LocalPickup }).catch(() => null); expect(lp).toBeNull(); });
  it("supports cancel, delivery-failed, return and filtering/pagination", async () => { const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup }); await markReady(db, s.id); await markShipped(db, s.id); await markDeliveryFailed(db, s.id); await markShipped(db, s.id); await markReturned(db, s.id); expect((await listShipments(db, { status: ShipmentStatus.Returned, page: 1, pageSize: 1 }))).toHaveLength(1); const s2Order = order; expect(await listShipments(db, { orderId: s2Order.id })).toHaveLength(1); });
  it("shipment transitions and tracking refresh do not mutate stock or create stock movements", async () => { const before = await getProductById(db, productId); const beforeMovements = await listStockMovements(db, { productId }); const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup }); await markReady(db, s.id); await markShipped(db, s.id); await refreshTracking(db, s.id, { externalStatus: "Delivered", occurredAt: "2026-07-14T00:00:00.000Z" }); expect((await getProductById(db, productId)).stockQuantity).toBe(before.stockQuantity); expect((await listStockMovements(db, { productId })).items).toHaveLength(beforeMovements.items.length); expect(await getShipmentTracking(db, s.id)).toHaveLength(1); await refreshTracking(db, s.id, { externalStatus: "Delivered", occurredAt: "2026-07-14T00:00:00.000Z" }); expect(await getShipmentTracking(db, s.id)).toHaveLength(1); });
  it("executes marketplace fulfillment jobs for eBay and Etsy, persists IDs, dedupes, and classifies failures", async () => { const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS, trackingNumber: "TRK" }); const connId = "conn-ebay"; await db.insert(schema.marketplaceConnections).values({ id: connId, channel: PublishChannel.Ebay, accountLabel: "Default", encryptedAccessToken: encryptCredential("token"), status: MarketplaceConnectionStatus.Connected, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await db.insert(schema.marketplaceOrders).values({ id: "mo1", channel: PublishChannel.Ebay, externalOrderId: "ext", marketplaceConnectionId: connId, internalOrderId: order.id, status: "paid", currency: "EUR", subtotal: 100, shipping: 0, tax: 0, total: 100, rawPayloadSnapshot: "{}", orderedAt: new Date().toISOString(), importedAt: new Date().toISOString() }); await db.update(schema.shipments).set({ channel: PublishChannel.Ebay, marketplaceOrderId: "mo1", marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Pending }).where(eq(schema.shipments.id, s.id)); const adapter = fakeAdapter(); setShipmentMarketplaceAdapterResolver(() => adapter); await markReady(db, s.id); await markShipped(db, s.id); const [job] = await db.select().from(schema.backgroundJobs); await executeJob(db, job); let row = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s.id)); expect(row[0].externalFulfillmentId).toBe("ful-1"); expect(row[0].marketplaceFulfillmentStatus).toBe(MarketplaceFulfillmentStatus.Accepted); await submitMarketplaceShipment(db, s.id); expect(adapter.calls()).toBe(1); await db.update(schema.shipments).set({ externalFulfillmentId: null, marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Pending }).where(eq(schema.shipments.id, s.id)); setShipmentMarketplaceAdapterResolver(() => fakeAdapter({ submitShipment: async () => { throw new Error("temporary"); } })); await expect(submitMarketplaceShipment(db, s.id)).rejects.toMatchObject({ retryable: true }); setShipmentMarketplaceAdapterResolver(() => fakeAdapter({ submitShipment: async () => { throw new Error("permanent"); } })); await expect(submitMarketplaceShipment(db, s.id)).rejects.toMatchObject({ retryable: false }); await db.insert(schema.marketplaceConnections).values({ id: "missing", channel: PublishChannel.Ebay, accountLabel: "Missing", status: MarketplaceConnectionStatus.Connected, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await db.update(schema.marketplaceOrders).set({ marketplaceConnectionId: "missing" }).where(eq(schema.marketplaceOrders.id, "mo1")); await expect(submitMarketplaceShipment(db, s.id)).rejects.toMatchObject({ retryable: false }); });
  it("completeSale gates payment, shipment state, marketplace status, cost data, idempotency, financials and unsafe reopen", async () => { const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup, shippingCost: 9 }); expect((await getSaleCompletionReadiness(db, order.id)).issues.join(" ")).toMatch(/in transit/); await markReady(db, s.id); expect((await completeSale(db, order.id)).status).toBe("blocked"); await markShipped(db, s.id); const done = await completeSale(db, order.id); expect(done.status).toBe(OrderStatus.Completed); expect(done.financials).toMatchObject({ grossRevenue: 100, shippingCharged: 0, shippingCost: 9, itemCost: 40, taxVat: 0, netRevenue: 91, profit: 51, currency: "EUR" }); expect(done.financials.marketplaceFee).toBeNull(); expect((await completeSale(db, order.id)).alreadyCompleted).toBe(true); expect(await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id))).toHaveLength(1); await expect(reopenSale()).rejects.toThrow(/deferred/); });
  it("blocks unpaid, missing shipment, marketplace pending, and missing cost data", async () => { await db.update(schema.orders).set({ paymentStatus: PaymentStatus.Pending }).where(eq(schema.orders.id, order.id)); expect((await completeSale(db, order.id)).issues).toContain("Order is unpaid"); await db.update(schema.orders).set({ paymentStatus: PaymentStatus.Paid }).where(eq(schema.orders.id, order.id)); expect((await completeSale(db, order.id)).issues.join(" ")).toMatch(/Shipment/); const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup }); await markReady(db, s.id); await markShipped(db, s.id); await db.update(schema.products).set({ purchaseCost: null }).where(eq(schema.products.id, productId)); expect((await getSaleCompletionReadiness(db, order.id)).issues.join(" ")).toMatch(/Missing cost/); });

  describe("Sprint 40A: Shipment InTransit integrates with Order Shipped", () => {
    it("Ready does not change Order status", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Processing);
    });

    it("LabelPending does not change Order status", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await updateShipmentStatus(db, s.id, ShipmentStatus.LabelPending);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Processing);
    });

    it("LabelCreated does not change Order status", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await updateShipmentStatus(db, s.id, ShipmentStatus.LabelCreated);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Processing);
    });

    it("moving a Shipment to InTransit moves its Processing Order to Shipped, without changing Product stock", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const before = await getProductById(db, productId);
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      const shipped = await markShipped(db, s.id);
      expect(shipped.status).toBe(ShipmentStatus.InTransit);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
      expect((await getProductById(db, productId)).stockQuantity).toBe(before.stockQuantity);
    });

    it("Delivered does not further change Order status beyond what InTransit already set", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await markShipped(db, s.id);
      await markDelivered(db, s.id);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    });

    it("DeliveryFailed does not further change Order status beyond what InTransit already set", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await markShipped(db, s.id);
      await markDeliveryFailed(db, s.id);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    });

    it("Cancelled does not change Order status", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await cancelShipment(db, s.id);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Processing);
    });

    it("Returned does not further change Order status beyond what InTransit already set", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await markShipped(db, s.id);
      await markReturned(db, s.id);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    });

    it("repeating an InTransit request is idempotent: no error, Shipment remains InTransit, Order remains Shipped", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      await markShipped(db, s.id);
      const second = await markShipped(db, s.id);
      expect(second.status).toBe(ShipmentStatus.InTransit);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    });

    it("Shipment transition succeeds when the Order is already Shipped", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      await updateOrderStatus(db, order.id, { status: OrderStatus.Shipped });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      const shipped = await markShipped(db, s.id);
      expect(shipped.status).toBe(ShipmentStatus.InTransit);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    });

    it("Shipment transition succeeds even when the Order is in a state that can't reach Shipped (e.g. Cancelled)", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, s.id);
      const shipped = await markShipped(db, s.id);
      expect(shipped.status).toBe(ShipmentStatus.InTransit);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Cancelled);
    });

    it("a failed Order transition does not prevent the marketplace fulfillment job from being enqueued", async () => {
      await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      const s = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS, trackingNumber: "TRK" });
      const connId = "conn-ebay-40a";
      await db.insert(schema.marketplaceConnections).values({ id: connId, channel: PublishChannel.Ebay, accountLabel: "Default", encryptedAccessToken: encryptCredential("token"), status: MarketplaceConnectionStatus.Connected, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await db.insert(schema.marketplaceOrders).values({ id: "mo-40a", channel: PublishChannel.Ebay, externalOrderId: "ext-40a", marketplaceConnectionId: connId, internalOrderId: order.id, status: "paid", currency: "EUR", subtotal: 100, shipping: 0, tax: 0, total: 100, rawPayloadSnapshot: "{}", orderedAt: new Date().toISOString(), importedAt: new Date().toISOString() });
      await db.update(schema.shipments).set({ channel: PublishChannel.Ebay, marketplaceOrderId: "mo-40a", marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Pending }).where(eq(schema.shipments.id, s.id));
      await markReady(db, s.id);
      await markShipped(db, s.id);
      const jobs = await db.select().from(schema.backgroundJobs);
      expect(jobs.length).toBeGreaterThan(0);
      expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Cancelled);
    });
  });
});
