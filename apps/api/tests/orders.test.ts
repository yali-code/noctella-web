import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import {
  createOrder,
  updateOrderStatus,
  formatOrderNumber,
  getOrderById,
  getOrderByOrderNumber,
  listOrders,
} from "../src/services/orders";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { createOrderSchema, orderListQuerySchema } from "../src/validation/order";
import { createTestDb } from "./testDb";

describe("order service", () => {
  let db: ReturnType<typeof createTestDb>;
  let productId: string;
  let categoryId: string;

  const address = {
    fullName: "Jane Collector",
    line1: "1 Rue Noctella",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  };

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const product = await createProduct(db, {
      sku: "SKU-ORDER-001",
      title: "Vintage Chronograph",
      slug: "cart-title-ignored",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 1200,
      stockQuantity: 1,
      images: [{ url: "https://example.com/watch.jpg", altText: "Watch", sortOrder: 0, isPrimary: true }],
    });
    productId = product.id;
  });

  function baseOrderInput(overrides: Record<string, unknown> = {}) {
    return {
      orderDraftId: "draft-1",
      guestEmail: "jane@example.com",
      status: OrderStatus.Pending,
      paymentStatus: PaymentStatus.Paid,
      paymentProvider: PaymentProvider.Stripe,
      paymentReference: "mock_stripe_ref_1",
      currency: "EUR" as const,
      billingAddress: address,
      shippingAddress: address,
      subtotalAmount: 1200,
      totalAmount: 1200,
      items: [{ productId, quantity: 1 as const }],
      ...overrides,
    };
  }

  it("formats order numbers as NOC-YYYYMMDD-XXXXXX", () => {
    expect(formatOrderNumber(new Date("2026-07-13T00:00:00.000Z"), 42)).toBe("NOC-20260713-000042");
  });

  it("creates a paid order and fetches it by id and order number", async () => {
    const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));

    expect(order.orderNumber).toMatch(/^NOC-\d{8}-\d{6}$/);
    expect(order.paymentStatus).toBe(PaymentStatus.Paid);
    expect(order.paymentReference).toBe("mock_stripe_ref_1");
    expect(order.shippingAmount).toBe(0);
    expect(order.taxAmount).toBe(0);
    expect(order.totalAmount).toBe(order.subtotalAmount);
    expect(order.items[0].quantity).toBe(1);

    await expect(getOrderById(db, order.id)).resolves.toMatchObject({ id: order.id });
    await expect(getOrderByOrderNumber(db, order.orderNumber)).resolves.toMatchObject({ id: order.id });
  });

  it("rejects unpaid orders and missing payment references", async () => {
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput({ paymentStatus: PaymentStatus.Pending }))),
    ).rejects.toBeInstanceOf(BadRequestError);

    const missingReference = createOrderSchema.safeParse(baseOrderInput({ paymentReference: "" }));
    expect(missingReference.success).toBe(false);
  });

  it("rejects missing or unpublished products", async () => {
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput({ items: [{ productId: "missing", quantity: 1 }] }))),
    ).rejects.toBeInstanceOf(NotFoundError);

    await updateProduct(db, productId, { status: ProductStatus.Draft });
    await expect(createOrder(db, createOrderSchema.parse(baseOrderInput()))).rejects.toBeInstanceOf(BadRequestError);
  });

  it("uses backend product snapshots and prices", async () => {
    const order = await createOrder(
      db,
      createOrderSchema.parse(
        baseOrderInput({
          items: [{ productId, quantity: 1, title: "Fake cart title", unitPrice: 1 }],
          subtotalAmount: 1200,
          totalAmount: 1200,
        }),
      ),
    );

    expect(order.items[0]).toMatchObject({
      productTitle: "Vintage Chronograph",
      productSlug: "cart-title-ignored",
      productType: ProductType.UniqueItem,
      productImageUrl: "https://example.com/watch.jpg",
      unitPrice: 1200,
      totalPrice: 1200,
    });
  });

  it("rejects mismatched totals", async () => {
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput({ subtotalAmount: 1, totalAmount: 1 }))),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("returns the existing order for a duplicate orderDraftId", async () => {
    const first = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const second = await createOrder(
      db,
      createOrderSchema.parse(baseOrderInput({ paymentReference: "another-reference", totalAmount: 999 })),
    );
    expect(second.id).toBe(first.id);
    expect(second.orderNumber).toBe(first.orderNumber);
  });

  it("updates order status without changing payment status or product state", async () => {
    const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const before = await getProductById(db, productId);

    const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Confirmed });
    const after = await getProductById(db, productId);

    expect(updated.status).toBe(OrderStatus.Confirmed);
    expect(updated.paymentStatus).toBe(PaymentStatus.Paid);
    expect(after.stockQuantity).toBe(before.stockQuantity);
    expect(after.status).toBe(before.status);
  });

  it("rejects invalid status updates and unknown order status updates", async () => {
    const invalidStatus = updateOrderStatus(db, "missing", { status: "invalid" as OrderStatus });
    await expect(invalidStatus).rejects.toBeInstanceOf(NotFoundError);

    const parsed = (await import("../src/validation/order")).updateOrderStatusSchema.safeParse({ status: "invalid" });
    expect(parsed.success).toBe(false);

    await expect(updateOrderStatus(db, "missing", { status: OrderStatus.Confirmed })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("lists, searches, paginates, and filters by order/payment status", async () => {
    const paid = await createOrder(db, createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-paid" })));
    await createOrder(db, createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-complete", status: OrderStatus.Completed })));

    const pending = await listOrders(db, orderListQuerySchema.parse({ status: OrderStatus.Pending }));
    expect(pending.data.map((order) => order.id)).toEqual([paid.id]);

    const paidOnly = await listOrders(db, orderListQuerySchema.parse({ paymentStatus: PaymentStatus.Paid }));
    expect(paidOnly.data).toHaveLength(2);

    const search = await listOrders(db, orderListQuerySchema.parse({ search: paid.orderNumber.slice(-6) }));
    expect(search.data.map((order) => order.id)).toContain(paid.id);

    const page = await listOrders(db, orderListQuerySchema.parse({ page: 1, pageSize: 1 }));
    expect(page.data).toHaveLength(1);
    expect(page.pagination.total).toBe(2);
    expect(page.pagination.totalPages).toBe(2);
  });

  it("rejects quantities other than one and never mutates products", async () => {
    const invalid = createOrderSchema.safeParse(baseOrderInput({ items: [{ productId, quantity: 2 }] }));
    expect(invalid.success).toBe(false);

    const before = await getProductById(db, productId);
    await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const after = await getProductById(db, productId);

    expect(after.stockQuantity).toBe(before.stockQuantity);
    expect(after.priceEur).toBe(before.priceEur);
    expect(after.status).toBe(before.status);
  });
});
