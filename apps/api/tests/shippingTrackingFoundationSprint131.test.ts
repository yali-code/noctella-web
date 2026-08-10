import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CarrierCode, MarketplaceConnectionStatus, OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType, PublishChannel, ShipmentStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { createOrder, getOrderById, updateOrderStatus } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { assignTracking, cancelShipment, createShipment, getShipment, markDelivered, markDeliveryFailed, markReady, markReturned, markShipped, updateShipment } from "../src/services/shipments";

const address = { fullName: "Buyer", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" };
let db: ReturnType<typeof createTestDb>;
let sequence = 0;

async function fixture(orderStatus: OrderStatus = OrderStatus.Processing, packingStatus = "ReadyForShipment") {
  const n = ++sequence;
  const category = await createCategory(db, { name: `Category ${n}`, isActive: true, displayOrder: n });
  const product = await createProduct(db, { sku: `S131-${n}`, title: `Product ${n}`, slug: `product-${n}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, priceEur: 10, purchaseCost: 4, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
  const paymentReference = `payment-${n}`;
  await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: paymentReference, status: PaymentStatus.Paid, amount: 10, currency: "EUR", idempotencyKey: `payment-${n}` });
  const order = await createOrder(db, { orderDraftId: `draft-${n}`, guestEmail: "buyer@example.com", status: OrderStatus.Pending, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference, currency: "EUR", billingAddress: address, shippingAddress: address, subtotalAmount: 10, totalAmount: 10, items: [{ productId: product.id, quantity: 1 }] });
  await db.update(schema.orders).set({ status: orderStatus }).where(eq(schema.orders.id, order.id));
  const now = new Date().toISOString();
  const packingTaskId = `packing-${n}`;
  await db.insert(schema.packingTasks).values({ id: packingTaskId, orderId: order.id, status: packingStatus, packageCount: 1, createdAt: now, updatedAt: now });
  await db.insert(schema.packingTaskLines).values({ id: `packing-line-${n}`, packingTaskId, productId: product.id, orderItemId: order.items[0].id, quantity: 1, createdAt: now });
  return { order, product, packingTaskId };
}

async function marketplaceShipment() {
  const result = await fixture();
  const now = new Date().toISOString();
  const connectionId = `connection-${sequence}`;
  const marketplaceOrderId = `marketplace-order-${sequence}`;
  await db.insert(schema.marketplaceConnections).values({ id: connectionId, channel: PublishChannel.Ebay, accountLabel: `Sprint 131 ${sequence}`, encryptedAccessToken: "test-token", status: MarketplaceConnectionStatus.Connected, createdAt: now, updatedAt: now });
  await db.insert(schema.marketplaceOrders).values({ id: marketplaceOrderId, channel: PublishChannel.Ebay, externalOrderId: `external-${sequence}`, marketplaceConnectionId: connectionId, internalOrderId: result.order.id, status: "paid", currency: "EUR", subtotal: 10, shipping: 0, tax: 0, total: 10, rawPayloadSnapshot: "{}", orderedAt: now, importedAt: now });
  const shipment = await createShipment(db, { orderId: result.order.id, packingTaskId: result.packingTaskId, carrierCode: CarrierCode.LocalPickup });
  await markReady(db, shipment.id);
  return { ...result, shipment };
}

const eventsFor = (shipmentId: string) => db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, shipmentId));
const jobsFor = (shipmentId: string) => db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.idempotencyKey, `submit-shipment:${shipmentId}`));

beforeEach(() => { db = createTestDb(); sequence = 0; });

describe("Sprint 131 shipping and tracking foundation", () => {
  it("atomically creates a Draft shipment from Processing + ReadyForShipment and consumes the packing task", async () => {
    const { order, packingTaskId } = await fixture();
    const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.UPS });
    expect(shipment).toMatchObject({ orderId: order.id, status: ShipmentStatus.Draft });
    const [packing] = await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.id, packingTaskId));
    expect(packing.shipmentId).toBe(shipment.id);
  });

  it("rejects every non-Processing order lifecycle", async () => {
    for (const status of [OrderStatus.Draft, OrderStatus.Pending, OrderStatus.Confirmed, OrderStatus.Shipped, OrderStatus.Completed, OrderStatus.Cancelled]) {
      const { order, packingTaskId } = await fixture(status);
      await expect(createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.UPS })).rejects.toThrow(/Processing/);
    }
  });

  it("rejects non-ready, foreign, consumed, missing, and quantity-mismatched packing tasks", async () => {
    for (const status of ["Pending", "InProgress", "Packed", "Cancelled"]) {
      const { order, packingTaskId } = await fixture(OrderStatus.Processing, status);
      await expect(createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.UPS })).rejects.toThrow(/ReadyForShipment/);
    }
    const first = await fixture();
    const second = await fixture();
    await expect(createShipment(db, { orderId: first.order.id, packingTaskId: second.packingTaskId, carrierCode: CarrierCode.UPS })).rejects.toThrow(/belong/);
    await expect(createShipment(db, { orderId: first.order.id, packingTaskId: "missing", carrierCode: CarrierCode.UPS })).rejects.toThrow(/not found/);
    await expect(createShipment(db, { orderId: first.order.id, packingTaskId: first.packingTaskId, carrierCode: CarrierCode.UPS, items: [{ orderItemId: first.order.items[0].id, quantity: 2 }] })).rejects.toThrow(/exactly match/);
    const shipment = await createShipment(db, { orderId: first.order.id, packingTaskId: first.packingTaskId, carrierCode: CarrierCode.UPS });
    await cancelShipment(db, shipment.id);
    await expect(createShipment(db, { orderId: first.order.id, packingTaskId: first.packingTaskId, carrierCode: CarrierCode.UPS })).rejects.toThrow(/associated/);
  });

  it("blocks order cancellation before SaleRollback while an active shipment exists", async () => {
    const { order, product, packingTaskId } = await fixture();
    const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.UPS });
    const stock = (await getProductById(db, product.id)).stockQuantity;
    await db.update(schema.packingTasks).set({ status: "Cancelled" }).where(eq(schema.packingTasks.id, packingTaskId));
    await expect(updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).rejects.toThrow(/cancelled first/);
    expect((await getProductById(db, product.id)).stockQuantity).toBe(stock);
    expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).filter((movement) => movement.type === "sale_rollback")).toHaveLength(0);
    await cancelShipment(db, shipment.id);
    expect((await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).status).toBe(OrderStatus.Cancelled);
  });

  it("blocks order cancellation for Ready and LabelCreated shipments after warehouse tasks are cancelled", async () => {
    for (const target of [ShipmentStatus.Ready, ShipmentStatus.LabelCreated]) {
      const { order, packingTaskId } = await fixture();
      const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.LocalPickup });
      await markReady(db, shipment.id);
      if (target === ShipmentStatus.LabelCreated) await db.update(schema.shipments).set({ status: ShipmentStatus.LabelCreated }).where(eq(schema.shipments.id, shipment.id));
      await db.update(schema.packingTasks).set({ status: "Cancelled" }).where(eq(schema.packingTasks.id, packingTaskId));
      await expect(updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).rejects.toThrow(/cancelled first/);
    }
  });

  it("atomically hands off InTransit + Shipped and keeps marketplace persistence out of direct orders", async () => {
    const { order, packingTaskId } = await fixture();
    const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, shipment.id);
    await markShipped(db, shipment.id);
    expect((await getShipment(db, shipment.id)).status).toBe(ShipmentStatus.InTransit);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(0);
    await markShipped(db, shipment.id);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(0);
  });

  it("rejects inconsistent InTransit replay and locks operator carrier/tracking edits from handoff onward", async () => {
    const { order, packingTaskId } = await fixture();
    const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.UPS });
    await assignTracking(db, shipment.id, { trackingNumber: "TRACK" });
    await markReady(db, shipment.id);
    await markShipped(db, shipment.id);
    await db.update(schema.orders).set({ status: OrderStatus.Cancelled }).where(eq(schema.orders.id, order.id));
    await expect(markShipped(db, shipment.id)).rejects.toThrow(/coherently Shipped/);
    await expect(assignTracking(db, shipment.id, { trackingNumber: "CHANGED" })).rejects.toThrow(/cannot be edited/);
    await db.update(schema.orders).set({ status: OrderStatus.Shipped }).where(eq(schema.orders.id, order.id));
    await markDelivered(db, shipment.id);
    await expect(updateShipment(db, shipment.id, { trackingUrl: "https://example.invalid" })).rejects.toThrow(/cannot be edited/);
  });

  it("locks normal tracking edits in DeliveryFailed, Returned, and Cancelled states", async () => {
    const failedFixture = await fixture();
    const failed = await createShipment(db, { orderId: failedFixture.order.id, packingTaskId: failedFixture.packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, failed.id); await markShipped(db, failed.id); await markDeliveryFailed(db, failed.id);
    await expect(assignTracking(db, failed.id, { trackingNumber: "CHANGED" })).rejects.toThrow(/cannot be edited/);

    const returnedFixture = await fixture();
    const returned = await createShipment(db, { orderId: returnedFixture.order.id, packingTaskId: returnedFixture.packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, returned.id); await markShipped(db, returned.id); await markReturned(db, returned.id);
    await expect(assignTracking(db, returned.id, { trackingNumber: "CHANGED" })).rejects.toThrow(/cannot be edited/);

    const cancelledFixture = await fixture();
    const cancelled = await createShipment(db, { orderId: cancelledFixture.order.id, packingTaskId: cancelledFixture.packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await cancelShipment(db, cancelled.id);
    await expect(assignTracking(db, cancelled.id, { trackingNumber: "CHANGED" })).rejects.toThrow(/cannot be edited/);
  });

  it("rolls back order, shipment, event, and marketplace job when the handoff transaction fails", async () => {
    const { order, shipment } = await marketplaceShipment();
    const beforeEvents = await eventsFor(shipment.id);
    (db as any).session.client.exec("CREATE TRIGGER sprint131_fail_intransit_event BEFORE INSERT ON shipment_events WHEN NEW.new_status = 'in_transit' BEGIN SELECT RAISE(ABORT, 'forced Sprint 131 event failure'); END");
    await expect(markShipped(db, shipment.id)).rejects.toThrow(/forced Sprint 131 event failure/);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Processing);
    expect((await getShipment(db, shipment.id)).status).toBe(ShipmentStatus.Ready);
    expect(await eventsFor(shipment.id)).toHaveLength(beforeEvents.length);
    expect(await jobsFor(shipment.id)).toHaveLength(0);
  });

  it("persists exactly one marketplace handoff job and replays without duplicate state", async () => {
    const { order, shipment } = await marketplaceShipment();
    await markShipped(db, shipment.id);
    const handedOff = await getShipment(db, shipment.id);
    const eventCount = (await eventsFor(shipment.id)).length;
    const jobs = await jobsFor(shipment.id);
    expect(handedOff.status).toBe(ShipmentStatus.InTransit);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "submit_marketplace_shipment", idempotencyKey: `submit-shipment:${shipment.id}` });
    expect(JSON.parse(jobs[0].payloadSnapshot)).toEqual({ shipmentId: shipment.id });
    await markShipped(db, shipment.id);
    expect(await jobsFor(shipment.id)).toHaveLength(1);
    expect(await eventsFor(shipment.id)).toHaveLength(eventCount);
    expect((await getShipment(db, shipment.id)).shippedAt).toBe(handedOff.shippedAt);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
  });

  it("rejects a failed marketplace handoff without partial state or durable work", async () => {
    const { order, shipment } = await marketplaceShipment();
    const beforeEvents = (await eventsFor(shipment.id)).length;
    await db.update(schema.orders).set({ status: OrderStatus.Cancelled }).where(eq(schema.orders.id, order.id));
    await expect(markShipped(db, shipment.id)).rejects.toThrow(/Processing/);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Cancelled);
    expect((await getShipment(db, shipment.id)).status).toBe(ShipmentStatus.Ready);
    expect(await eventsFor(shipment.id)).toHaveLength(beforeEvents);
    expect(await jobsFor(shipment.id)).toHaveLength(0);
  });

  it("rejects every divergent InTransit replay without event or job side effects", async () => {
    for (const status of [OrderStatus.Pending, OrderStatus.Confirmed, OrderStatus.Processing, OrderStatus.Completed, OrderStatus.Cancelled]) {
      const { order, shipment } = await marketplaceShipment();
      await markShipped(db, shipment.id);
      const eventCount = (await eventsFor(shipment.id)).length;
      const jobCount = (await jobsFor(shipment.id)).length;
      await db.update(schema.orders).set({ status }).where(eq(schema.orders.id, order.id));
      await expect(markShipped(db, shipment.id)).rejects.toThrow(/coherently Shipped/);
      expect(await eventsFor(shipment.id)).toHaveLength(eventCount);
      expect(await jobsFor(shipment.id)).toHaveLength(jobCount);
    }
  });

  it("retries DeliveryFailed to InTransit with an already-Shipped order and idempotent marketplace work", async () => {
    const { order, shipment } = await marketplaceShipment();
    await markShipped(db, shipment.id);
    await markDeliveryFailed(db, shipment.id);
    await markShipped(db, shipment.id);
    expect((await getShipment(db, shipment.id)).status).toBe(ShipmentStatus.InTransit);
    expect((await getOrderById(db, order.id)).status).toBe(OrderStatus.Shipped);
    expect(await jobsFor(shipment.id)).toHaveLength(1);
  });

  it("requires tracking for ordinary carriers while exempting LocalPickup", async () => {
    const ordinary = await fixture();
    const ups = await createShipment(db, { orderId: ordinary.order.id, packingTaskId: ordinary.packingTaskId, carrierCode: CarrierCode.UPS });
    await markReady(db, ups.id);
    await expect(markShipped(db, ups.id)).rejects.toThrow(/Tracking number/);
    await assignTracking(db, ups.id, { trackingNumber: "TRACK-131" });
    await markShipped(db, ups.id);
    expect((await getShipment(db, ups.id)).status).toBe(ShipmentStatus.InTransit);

    const pickup = await fixture();
    const local = await createShipment(db, { orderId: pickup.order.id, packingTaskId: pickup.packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, local.id);
    await markShipped(db, local.id);
    expect((await getShipment(db, local.id)).status).toBe(ShipmentStatus.InTransit);
  });

  it("keeps Delivered, DeliveryFailed, and Returned logistics-only for COD", async () => {
    const { order, product, packingTaskId } = await fixture();
    await db.update(schema.orders).set({ paymentProvider: PaymentProvider.CashOnDelivery, paymentStatus: PaymentStatus.Pending, paymentReference: null }).where(eq(schema.orders.id, order.id));
    const shipment = await createShipment(db, { orderId: order.id, packingTaskId, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, shipment.id);
    await markShipped(db, shipment.id);
    const stock = (await getProductById(db, product.id)).stockQuantity;
    const baseline = { payments: (await db.select().from(schema.payments)).length, paymentEvents: (await db.select().from(schema.paymentEvents)).length, invoices: (await db.select().from(schema.invoices)).length, finance: (await db.select().from(schema.financeEntries)).length, movements: (await db.select().from(schema.stockMovements)).length };
    await markDeliveryFailed(db, shipment.id);
    await markShipped(db, shipment.id);
    await markDelivered(db, shipment.id);
    await markReturned(db, shipment.id);
    const persistedOrder = await getOrderById(db, order.id);
    expect(persistedOrder).toMatchObject({ status: OrderStatus.Shipped, paymentStatus: PaymentStatus.Pending, paymentProvider: PaymentProvider.CashOnDelivery });
    expect((await getProductById(db, product.id)).stockQuantity).toBe(stock);
    expect(await db.select().from(schema.payments)).toHaveLength(baseline.payments);
    expect(await db.select().from(schema.paymentEvents)).toHaveLength(baseline.paymentEvents);
    expect(await db.select().from(schema.invoices)).toHaveLength(baseline.invoices);
    expect(await db.select().from(schema.financeEntries)).toHaveLength(baseline.finance);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(baseline.movements);
    expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).filter((movement) => movement.type === "sale_rollback")).toHaveLength(0);
  });
});
