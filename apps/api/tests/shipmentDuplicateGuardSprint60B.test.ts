import { beforeEach, describe, expect, it, vi } from "vitest";
import { CarrierCode, OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType, ShipmentStatus } from "@noctella/shared";
import { ConflictError } from "../src/services/errors";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { createShipment, cancelShipment, markReady, markShipped, markReturned, getShipmentEvents } from "../src/services/shipments";
import { createTestDb } from "./testDb";

const key = Buffer.alloc(32, 12).toString("base64");
const address = { fullName: "Jane", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" };

/**
 * Sprint 60B: createShipmentUseCase previously only handled a Draft-status existing shipment
 * gracefully (idempotent replay); any other active status fell through to a raw INSERT, relying
 * on an incidental SQLite-only unique index for protection and giving no protection on Postgres.
 * This proves the application-level guard added in createShipmentUseCase (Sprint 60A finding).
 */
describe("createShipment duplicate-active-shipment guard (Sprint 60B)", () => {
  let db: ReturnType<typeof createTestDb>;
  let order: any;

  beforeEach(async () => {
    process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = key;
    vi.restoreAllMocks();
    db = createTestDb();
    const category = await createCategory(db, { name: "Cat", isActive: true, displayOrder: 0 });
    const product = await createProduct(db, { sku: "DUP-1", title: "Vase", slug: "vase-dup", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, priceEur: 100, purchaseCost: 40, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "pay-dup", status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: "test:pay-dup" });
    order = await createOrder(db, { orderDraftId: `draft-${Math.random()}`, guestEmail: "j@example.com", status: OrderStatus.Pending, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "pay-dup", currency: "EUR", billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId: product.id, quantity: 1 }] });
  });

  it("a second create call while the existing shipment is still Draft replays the same shipment (unchanged behavior)", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    const second = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(ShipmentStatus.Draft);
  });

  it("a second create call while the existing shipment is Ready (active, non-Draft) is rejected with ConflictError", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    await markReady(db, first.id);
    await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS })).rejects.toBeInstanceOf(ConflictError);
  });

  it("a second create call while the existing shipment is InTransit (active, non-Draft) is rejected with ConflictError", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, first.id);
    await markShipped(db, first.id);
    await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejecting a duplicate active shipment does not write a shipment event", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    await markReady(db, first.id);
    const before = await getShipmentEvents(db, first.id);
    await expect(createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS })).rejects.toBeInstanceOf(ConflictError);
    const after = await getShipmentEvents(db, first.id);
    expect(after).toHaveLength(before.length);
  });

  it("a Cancelled prior shipment does not block creating a new shipment for the same order", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    await cancelShipment(db, first.id);
    const second = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.UPS });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe(ShipmentStatus.Draft);
  });

  it("a Returned prior shipment does not block creating a new shipment for the same order", async () => {
    const first = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
    await markReady(db, first.id);
    await markShipped(db, first.id);
    await markReturned(db, first.id);
    const second = await createShipment(db, { orderId: order.id, carrierCode: CarrierCode.LocalPickup });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe(ShipmentStatus.Draft);
  });
});
