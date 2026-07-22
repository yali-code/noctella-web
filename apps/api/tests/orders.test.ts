import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { listStockMovements } from "../src/services/stockMovements";
import {
  createOrder,
  updateOrderStatus,
  formatOrderNumber,
  getOrderById,
  getOrderByOrderNumber,
  listOrders,
} from "../src/services/orders";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import { createOrderSchema, orderListQuerySchema } from "../src/validation/order";
import { createPaymentSession, findPaymentByProviderReference } from "../src/payments/paymentRepository";
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
    await seedPayment(db, PaymentProvider.Stripe, "mock_stripe_ref_1", PaymentStatus.Paid);
  });

  function seedPayment(
    testDb: ReturnType<typeof createTestDb>,
    provider: string,
    providerReference: string,
    status: string,
  ) {
    return createPaymentSession(testDb, {
      provider,
      providerReference,
      status,
      amount: 1200,
      currency: "EUR",
      idempotencyKey: `test:${provider}:${providerReference}:${Math.random()}`,
    });
  }

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
    await seedPayment(db, PaymentProvider.Stripe, "not-yet-paid", PaymentStatus.Pending);
    await expect(
      createOrder(
        db,
        createOrderSchema.parse(
          baseOrderInput({ paymentReference: "not-yet-paid", paymentStatus: PaymentStatus.Pending }),
        ),
      ),
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
    const second = await createOrder(db, createOrderSchema.parse(baseOrderInput({ totalAmount: 999 })));
    expect(second.id).toBe(first.id);
    expect(second.orderNumber).toBe(first.orderNumber);
  });

  it("updates order status without changing payment status", async () => {
    const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Confirmed });

    expect(updated.status).toBe(OrderStatus.Confirmed);
    expect(updated.paymentStatus).toBe(PaymentStatus.Paid);
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
    await seedPayment(db, PaymentProvider.Stripe, "ref-draft-paid", PaymentStatus.Paid);
    await seedPayment(db, PaymentProvider.Stripe, "ref-draft-complete", PaymentStatus.Paid);
    const paid = await createOrder(
      db,
      createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-paid", paymentReference: "ref-draft-paid" })),
    );
    await updateProduct(db, productId, { status: ProductStatus.Published, stockQuantity: 1 });
    await createOrder(
      db,
      createOrderSchema.parse(
        baseOrderInput({
          orderDraftId: "draft-complete",
          paymentReference: "ref-draft-complete",
          status: OrderStatus.Completed,
        }),
      ),
    );

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

  it("rejects quantities other than one and reduces stock once", async () => {
    const invalid = createOrderSchema.safeParse(baseOrderInput({ items: [{ productId, quantity: 2 }] }));
    expect(invalid.success).toBe(false);

    const before = await getProductById(db, productId);
    const movementsBefore = await listStockMovements(db, { productId, page: 1, pageSize: 20 });
    await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const after = await getProductById(db, productId);

    expect(after.stockQuantity).toBe(before.stockQuantity - 1);
    expect(after.priceEur).toBe(before.priceEur);
    expect(after.status).toBe(ProductStatus.Sold);

    const duplicate = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    const final = await getProductById(db, productId);
    const movements = await listStockMovements(db, { productId, page: 1, pageSize: 20 });
    expect(duplicate.id).toBeDefined();
    expect(final.stockQuantity).toBe(after.stockQuantity);
    expect(movements.items).toHaveLength(movementsBefore.items.length + 1);
  });

  describe("payment session order linkage", () => {
    it("creates the Order and links payments.order_id when the persisted payment is Paid", async () => {
      const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));

      const session = await findPaymentByProviderReference(db, PaymentProvider.Stripe, "mock_stripe_ref_1");
      expect(session?.orderId).toBe(order.id);
    });

    it("rejects with NotFoundError for an unknown provider/reference", async () => {
      await expect(
        createOrder(db, createOrderSchema.parse(baseOrderInput({ paymentReference: "never-initialized" }))),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a persisted Pending payment even when the client claims paymentStatus Paid", async () => {
      await seedPayment(db, PaymentProvider.Stripe, "still-pending", PaymentStatus.Pending);
      await expect(
        createOrder(
          db,
          createOrderSchema.parse(
            baseOrderInput({ paymentReference: "still-pending", paymentStatus: PaymentStatus.Paid }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects persisted Failed and Cancelled payments", async () => {
      await seedPayment(db, PaymentProvider.Stripe, "ref-failed", PaymentStatus.Failed);
      await seedPayment(db, PaymentProvider.Stripe, "ref-cancelled", PaymentStatus.Cancelled);

      await expect(
        createOrder(db, createOrderSchema.parse(baseOrderInput({ paymentReference: "ref-failed" }))),
      ).rejects.toBeInstanceOf(BadRequestError);
      await expect(
        createOrder(db, createOrderSchema.parse(baseOrderInput({ paymentReference: "ref-cancelled" }))),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects when the payment is already linked to another Order, before creating a new Order or mutating Inventory", async () => {
      await seedPayment(db, PaymentProvider.Stripe, "ref-shared", PaymentStatus.Paid);
      const first = await createOrder(
        db,
        createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-first", paymentReference: "ref-shared" })),
      );

      const before = await getProductById(db, productId);
      const ordersBefore = await listOrders(db, orderListQuerySchema.parse({}));

      await expect(
        createOrder(
          db,
          createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-second", paymentReference: "ref-shared" })),
        ),
      ).rejects.toBeInstanceOf(ConflictError);

      const after = await getProductById(db, productId);
      const ordersAfter = await listOrders(db, orderListQuerySchema.parse({}));
      expect(ordersAfter.pagination.total).toBe(ordersBefore.pagination.total);
      expect(after.stockQuantity).toBe(before.stockQuantity);

      const session = await findPaymentByProviderReference(db, PaymentProvider.Stripe, "ref-shared");
      expect(session?.orderId).toBe(first.id);
    });

    it("retrying with the same orderDraftId returns the same Order, keeps the same payment link, and causes no duplicate Inventory mutation", async () => {
      const first = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
      const afterFirst = await getProductById(db, productId);

      const second = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
      const afterSecond = await getProductById(db, productId);

      expect(second.id).toBe(first.id);
      expect(afterSecond.stockQuantity).toBe(afterFirst.stockQuantity);

      const session = await findPaymentByProviderReference(db, PaymentProvider.Stripe, "mock_stripe_ref_1");
      expect(session?.orderId).toBe(first.id);
    });

    it("re-linking the same payment session to the same Order is idempotent", async () => {
      const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
      await expect(createOrder(db, createOrderSchema.parse(baseOrderInput()))).resolves.toMatchObject({
        id: order.id,
      });

      const session = await findPaymentByProviderReference(db, PaymentProvider.Stripe, "mock_stripe_ref_1");
      expect(session?.orderId).toBe(order.id);
    });

    it("client-provided paymentStatus cannot override a persisted Paid session", async () => {
      const order = await createOrder(
        db,
        createOrderSchema.parse(baseOrderInput({ paymentStatus: PaymentStatus.Pending })),
      );
      expect(order.paymentStatus).toBe(PaymentStatus.Paid);
    });
  });
});
