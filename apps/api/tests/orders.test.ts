import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType, StockMovementType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
import { createOffer, acceptOffer, createDraftOrderFromOffer } from "../src/services/offers";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import { createOrderSchema, orderListQuerySchema } from "../src/validation/order";
import { createPaymentSession, findPaymentByProviderReference } from "../src/payments/paymentRepository";
import { products, productPhotos } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { createDrizzleOrderRepositories } from "../src/repositories/order/drizzle";
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
      // Sprint 86: deliberately no legacy `images` here - that write path targets the legacy
      // productImages table, which order creation's image snapshot must NOT read from (see
      // repositories/order/drizzle.ts's validateProductReferences). Tests that need this
      // product to have a photo seed a ProductPhoto row directly, matching the real upload path.
    });
    productId = product.id;
    await seedPayment(db, PaymentProvider.Stripe, "mock_stripe_ref_1", PaymentStatus.Paid);
  });

  function seedPayment(
    testDb: ReturnType<typeof createTestDb>,
    provider: string,
    providerReference: string,
    status: string,
    amount = 1200,
    currency = "EUR",
  ) {
    return createPaymentSession(testDb, {
      provider,
      providerReference,
      status,
      amount,
      currency,
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

  it("includes paymentProvider identically in both the list projection and the detail projection", async () => {
    const created = await createOrder(db, createOrderSchema.parse(baseOrderInput()));

    const list = await listOrders(db, orderListQuerySchema.parse({}));
    const listed = list.data.find((o) => o.id === created.id);
    expect(listed?.paymentProvider).toBe(PaymentProvider.Stripe);

    const detail = await getOrderById(db, created.id);
    expect(detail.paymentProvider).toBe(PaymentProvider.Stripe);
    expect(detail.paymentProvider).toBe(listed?.paymentProvider);

    // Everything else this projection carries remains exactly as before this fix.
    expect(listed?.status).toBe(detail.status);
    expect(listed?.paymentStatus).toBe(detail.paymentStatus);
    expect(listed?.totalAmount).toBe(detail.totalAmount);
    expect(listed?.currency).toBe(detail.currency);
    expect(detail.items[0].productTitle).toBe("Vintage Chronograph");
  });

  it("represents a missing paymentProvider safely (offer-derived Draft order, never paid) in both list and detail", async () => {
    const offerProduct = await createProduct(db, {
      sku: `SKU-NO-PROVIDER-${Math.random()}`,
      title: "No Provider Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: true,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 300,
      stockQuantity: 1,
    });
    const offer = await createOffer(db, {
      productId: offerProduct.id,
      customerName: "Jane Collector",
      customerEmail: "jane@example.com",
      offeredAmount: 300,
      currency: "EUR",
    });
    await acceptOffer(db, offer.id);
    const draftOrder = await createDraftOrderFromOffer(db, offer.id);

    const list = await listOrders(db, orderListQuerySchema.parse({}));
    const listed = list.data.find((o) => o.id === draftOrder.id);
    expect(listed?.paymentProvider ?? null).toBeNull();

    const detail = await getOrderById(db, draftOrder.id);
    expect(detail.paymentProvider ?? null).toBeNull();
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

  it("uses backend product snapshots and prices, and ignores a client-supplied image/title/price (Sprint 86)", async () => {
    // Real upload path (productPhotos), never the legacy productImages table.
    const now = new Date().toISOString();
    await db.insert(productPhotos).values({
      id: "ph-order-001",
      productId,
      url: "/images/product-photos/watch.webp",
      thumbnailUrl: "/images/product-photos/watch-thumb.webp",
      altText: "Watch",
      sortOrder: 0,
      isPrimary: true,
      filename: "watch.webp",
      mimeType: "image/webp",
      sizeBytes: 4096,
      width: 1500,
      height: 2000,
      processingStatus: "Ready",
      createdAt: now,
      updatedAt: now,
    } as any);

    const order = await createOrder(
      db,
      createOrderSchema.parse(
        baseOrderInput({
          items: [
            {
              productId,
              quantity: 1,
              title: "Fake cart title",
              unitPrice: 1,
              // Malicious/naive client-supplied image fields - orderItemInputSchema only
              // recognizes productId/quantity, so Zod strips these before they ever reach the
              // order-creation service.
              productImageUrl: "https://attacker.example/fake.jpg",
              imageUrl: "https://attacker.example/fake.jpg",
            },
          ],
          subtotalAmount: 1200,
          totalAmount: 1200,
        }),
      ),
    );

    expect(order.items[0]).toMatchObject({
      productSku: "SKU-ORDER-001",
      productTitle: "Vintage Chronograph",
      productSlug: "cart-title-ignored",
      productType: ProductType.UniqueItem,
      productImageUrl: "/images/product-photos/watch.webp",
      unitPrice: 1200,
      totalPrice: 1200,
      currency: "EUR",
    });
  });

  it("uses and snapshots the effective Noctella Web price for direct storefront orders", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 900 });
    await seedPayment(db, PaymentProvider.Stripe, "woo-price-paid", PaymentStatus.Paid, 900);
    const order = await createOrder(
      db,
      createOrderSchema.parse(baseOrderInput({
        orderDraftId: "draft-woo-price",
        paymentReference: "woo-price-paid",
        subtotalAmount: 900,
        totalAmount: 900,
        items: [{ productId, quantity: 1, unitPrice: 1 }],
      })),
      { pricingContext: "noctella_web" },
    );

    expect(order).toMatchObject({ subtotalAmount: 900, totalAmount: 900 });
    expect(order.items[0]).toMatchObject({ unitPrice: 900, totalPrice: 900 });
    expect((await getProductById(db, productId)).stockQuantity).toBe(0);
  });

  it("uses canonical fallback pricing for direct storefront orders without a Woo price", async () => {
    const order = await createOrder(
      db,
      createOrderSchema.parse(baseOrderInput()),
      { pricingContext: "noctella_web" },
    );
    expect(order.items[0]).toMatchObject({ unitPrice: 1200, totalPrice: 1200 });
  });

  it("accepts equivalent decimal EUR payment and authoritative subtotal values after cent normalization", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 0.1 });
    const secondProduct = await createProduct(db, {
      sku: "SKU-ORDER-DECIMAL",
      title: "Decimal Price Product",
      slug: "decimal-price-product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 0.2,
      stockQuantity: 1,
    });
    await seedPayment(db, PaymentProvider.Stripe, "decimal-paid-session", PaymentStatus.Paid, 0.3);

    const order = await createOrder(
      db,
      createOrderSchema.parse(baseOrderInput({
        orderDraftId: "draft-decimal-payment",
        paymentReference: "decimal-paid-session",
        subtotalAmount: 0.3,
        totalAmount: 0.3,
        items: [{ productId, quantity: 1 }, { productId: secondProduct.id, quantity: 1 }],
      })),
      { pricingContext: "noctella_web" },
    );

    expect(order.subtotalAmount).toBeCloseTo(0.3);
    expect(order.totalAmount).toBeCloseTo(0.3);
    expect(order.items.map((item: any) => item.unitPrice).sort((a: number, b: number) => a - b)).toEqual([0.1, 0.2]);
  });

  it("preserves canonical pricing for non-Noctella-Web internal orders", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 900 });
    const order = await createOrder(db, createOrderSchema.parse(baseOrderInput()));
    expect(order.items[0]).toMatchObject({ unitPrice: 1200, totalPrice: 1200 });
  });

  it("rejects stale direct-storefront totals without creating an order or mutating inventory", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 900 });
    const ordersBefore = await listOrders(db, orderListQuerySchema.parse({}));
    const movementsBefore = await listStockMovements(db, { productId, page: 1, pageSize: 20 });
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput()), { pricingContext: "noctella_web" }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect((await listOrders(db, orderListQuerySchema.parse({}))).pagination.total).toBe(ordersBefore.pagination.total);
    expect((await getProductById(db, productId)).stockQuantity).toBe(1);
    expect((await listStockMovements(db, { productId, page: 1, pageSize: 20 })).items).toHaveLength(movementsBefore.items.length);
  });

  it("rejects a paid-session amount that differs from the authoritative Noctella Web subtotal", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 900 });
    await seedPayment(db, PaymentProvider.Stripe, "wrong-paid-amount", PaymentStatus.Paid, 800);
    await expect(
      createOrder(
        db,
        createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-wrong-amount", paymentReference: "wrong-paid-amount", subtotalAmount: 900, totalAmount: 900 })),
        { pricingContext: "noctella_web" },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect((await getProductById(db, productId)).stockQuantity).toBe(1);
  });

  it("rejects a non-EUR paid session for direct Noctella Web checkout", async () => {
    await updateProduct(db, productId, { wooListingPriceEur: 900 });
    await seedPayment(db, PaymentProvider.Stripe, "usd-paid-session", PaymentStatus.Paid, 900, "USD");
    await expect(
      createOrder(
        db,
        createOrderSchema.parse(baseOrderInput({ orderDraftId: "draft-usd-session", paymentReference: "usd-paid-session", subtotalAmount: 900, totalAmount: 900 })),
        { pricingContext: "noctella_web" },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect((await getProductById(db, productId)).stockQuantity).toBe(1);
  });

  it("rejects mismatched totals", async () => {
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput({ subtotalAmount: 1, totalAmount: 1 }))),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects orders when stock is insufficient and mutates nothing", async () => {
    const category = await createCategory(db, { name: "Out of Stock", displayOrder: 0, isActive: true });
    const outOfStock = await createProduct(db, {
      sku: "SKU-OUT-OF-STOCK",
      title: "Sold Out Item",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      stockQuantity: 0,
    });
    await seedPayment(db, PaymentProvider.Stripe, "ref-out-of-stock", PaymentStatus.Paid);

    const ordersBefore = await listOrders(db, orderListQuerySchema.parse({}));
    const movementsBefore = await listStockMovements(db, { productId: outOfStock.id, page: 1, pageSize: 20 });

    await expect(
      createOrder(
        db,
        createOrderSchema.parse(
          baseOrderInput({
            orderDraftId: "draft-out-of-stock",
            paymentReference: "ref-out-of-stock",
            items: [{ productId: outOfStock.id, quantity: 1 }],
            subtotalAmount: 500,
            totalAmount: 500,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    const ordersAfter = await listOrders(db, orderListQuerySchema.parse({}));
    const movementsAfter = await listStockMovements(db, { productId: outOfStock.id, page: 1, pageSize: 20 });
    const afterProduct = await getProductById(db, outOfStock.id);
    expect(ordersAfter.pagination.total).toBe(ordersBefore.pagination.total);
    expect(movementsAfter.items).toHaveLength(movementsBefore.items.length);
    expect(afterProduct.stockQuantity).toBe(0);
  });

  it("rejects a non-EUR order currency even when the schema accepts the enum value", async () => {
    await expect(
      createOrder(db, createOrderSchema.parse(baseOrderInput({ currency: "USD" }))),
    ).rejects.toBeInstanceOf(BadRequestError);

    const after = await getProductById(db, productId);
    expect(after.stockQuantity).toBe(1);
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

  describe("order status transitions", () => {
    async function createOrderAtStatus(status: OrderStatus) {
      const category = await createCategory(db, { name: `Status-${Math.random()}`, displayOrder: 0, isActive: true });
      const product = await createProduct(db, {
        sku: `SKU-STATUS-${Math.random()}`,
        title: "Status Test Product",
        type: ProductType.UniqueItem,
        status: ProductStatus.Published,
        categoryId: category.id,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: false,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
        priceEur: 100,
        stockQuantity: 1,
      });
      const suffix = `${status}-${Math.random()}`;
      const reference = `ref-${suffix}`;
      await seedPayment(db, PaymentProvider.Stripe, reference, PaymentStatus.Paid);
      const order = await createOrder(
        db,
        createOrderSchema.parse({
          orderDraftId: `draft-${suffix}`,
          guestEmail: "jane@example.com",
          status,
          paymentStatus: PaymentStatus.Paid,
          paymentProvider: PaymentProvider.Stripe,
          paymentReference: reference,
          currency: "EUR",
          billingAddress: address,
          shippingAddress: address,
          subtotalAmount: 100,
          totalAmount: 100,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      );
      return { order, product };
    }

    const validEdges: Array<[OrderStatus, OrderStatus]> = [
      [OrderStatus.Draft, OrderStatus.Pending],
      [OrderStatus.Draft, OrderStatus.Confirmed],
      [OrderStatus.Pending, OrderStatus.Confirmed],
      [OrderStatus.Pending, OrderStatus.Processing],
      [OrderStatus.Pending, OrderStatus.Cancelled],
      [OrderStatus.Confirmed, OrderStatus.Processing],
      [OrderStatus.Confirmed, OrderStatus.Cancelled],
      [OrderStatus.Processing, OrderStatus.Shipped],
      [OrderStatus.Processing, OrderStatus.Cancelled],
    ];
    for (const [from, to] of validEdges) {
      it(`allows ${from} -> ${to}`, async () => {
        const { order } = await createOrderAtStatus(from);
        const updated = await updateOrderStatus(db, order.id, { status: to });
        expect(updated.status).toBe(to);
      });
    }

    const invalidEdges: Array<[OrderStatus, OrderStatus]> = [
      [OrderStatus.Draft, OrderStatus.Shipped],
      [OrderStatus.Pending, OrderStatus.Completed],
      [OrderStatus.Confirmed, OrderStatus.Draft],
      [OrderStatus.Processing, OrderStatus.Completed],
      [OrderStatus.Shipped, OrderStatus.Cancelled],
      [OrderStatus.Shipped, OrderStatus.Completed],
      [OrderStatus.Completed, OrderStatus.Processing],
      [OrderStatus.Completed, OrderStatus.Cancelled],
      [OrderStatus.Cancelled, OrderStatus.Processing],
    ];
    for (const [from, to] of invalidEdges) {
      it(`rejects ${from} -> ${to}`, async () => {
        const { order } = await createOrderAtStatus(from);
        await expect(updateOrderStatus(db, order.id, { status: to })).rejects.toBeInstanceOf(BadRequestError);
      });
    }

    it("treats Processing -> Processing as an idempotent success", async () => {
      const { order } = await createOrderAtStatus(OrderStatus.Processing);
      const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Processing });
      expect(updated.status).toBe(OrderStatus.Processing);
    });

    it("treats Completed -> Completed as an idempotent success", async () => {
      const { order } = await createOrderAtStatus(OrderStatus.Completed);
      const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Completed });
      expect(updated.status).toBe(OrderStatus.Completed);
    });

    it("treats Cancelled -> Cancelled as an idempotent success", async () => {
      const { order } = await createOrderAtStatus(OrderStatus.Cancelled);
      const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      expect(updated.status).toBe(OrderStatus.Cancelled);
    });

    it("Processing -> Cancelled restores Inventory and Product status atomically", async () => {
      const category = await createCategory(db, { name: `Lifecycle-${Math.random()}`, displayOrder: 0, isActive: true });
      const product = await createProduct(db, {
        sku: `SKU-LIFECYCLE-${Math.random()}`,
        title: "Lifecycle Test Product",
        type: ProductType.UniqueItem,
        status: ProductStatus.Published,
        categoryId: category.id,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: false,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
        priceEur: 100,
        stockQuantity: 1,
      });
      expect(product.status).toBe(ProductStatus.Published);
      expect(product.stockQuantity).toBe(1);

      const reference = `ref-lifecycle-${product.id}`;
      await seedPayment(db, PaymentProvider.Stripe, reference, PaymentStatus.Paid);
      const order = await createOrder(
        db,
        createOrderSchema.parse({
          orderDraftId: `draft-lifecycle-${product.id}`,
          guestEmail: "jane@example.com",
          status: OrderStatus.Processing,
          paymentStatus: PaymentStatus.Paid,
          paymentProvider: PaymentProvider.Stripe,
          paymentReference: reference,
          currency: "EUR",
          billingAddress: address,
          shippingAddress: address,
          subtotalAmount: 100,
          totalAmount: 100,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      );

      const afterSale = await getProductById(db, product.id);
      expect(afterSale.status).toBe(ProductStatus.Sold);
      expect(afterSale.stockQuantity).toBe(0);

      const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      expect(updated.status).toBe(OrderStatus.Cancelled);

      const afterCancel = await getProductById(db, product.id);
      expect(afterCancel.status).toBe(ProductStatus.Published);
      expect(afterCancel.stockQuantity).toBe(1);

      const rollbackMovements = await listStockMovements(db, {
        productId: product.id,
        page: 1,
        pageSize: 20,
        type: StockMovementType.SaleRollback,
      });
      expect(rollbackMovements.items).toHaveLength(1);
    });

    it("Confirmed -> Cancelled restores Inventory", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Confirmed);
      await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(1);
    });

    it("Draft -> Cancelled does not restore Inventory or change Product status, since Draft Orders never decrement it at creation", async () => {
      const category = await createCategory(db, { name: `Draft-${Math.random()}`, displayOrder: 0, isActive: true });
      const product = await createProduct(db, {
        sku: `SKU-DRAFT-${Math.random()}`,
        title: "Draft Test Product",
        type: ProductType.UniqueItem,
        status: ProductStatus.Published,
        categoryId: category.id,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: true,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
        priceEur: 900,
        stockQuantity: 1,
      });
      const offer = await createOffer(db, {
        productId: product.id,
        customerName: "Jane Collector",
        customerEmail: "jane@example.com",
        offeredAmount: 900,
        currency: "EUR",
      });
      await acceptOffer(db, offer.id);
      const draftOrder = await createDraftOrderFromOffer(db, offer.id);
      expect(draftOrder.status).toBe(OrderStatus.Draft);

      const before = await getProductById(db, product.id);
      expect(before.stockQuantity).toBe(1);
      expect(before.status).toBe(ProductStatus.Published);

      const updated = await updateOrderStatus(db, draftOrder.id, { status: OrderStatus.Cancelled });
      expect(updated.status).toBe(OrderStatus.Cancelled);

      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(1);
      expect(after.status).toBe(ProductStatus.Published);

      const rollbackMovements = await listStockMovements(db, {
        productId: product.id,
        page: 1,
        pageSize: 20,
        type: StockMovementType.SaleRollback,
      });
      expect(rollbackMovements.items).toHaveLength(0);
    });

    it("double cancellation does not double-restore Inventory or Product status and remains idempotent", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Processing);
      const first = await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      const afterFirst = await getProductById(db, product.id);
      expect(first.status).toBe(OrderStatus.Cancelled);
      expect(afterFirst.stockQuantity).toBe(1);
      expect(afterFirst.status).toBe(ProductStatus.Published);

      const second = await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      expect(second.status).toBe(OrderStatus.Cancelled);
      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(1);
      expect(after.status).toBe(ProductStatus.Published);

      const rollbackMovements = await listStockMovements(db, {
        productId: product.id,
        page: 1,
        pageSize: 20,
        type: StockMovementType.SaleRollback,
      });
      expect(rollbackMovements.items).toHaveLength(1);
    });

    it("cancellation restores stock but preserves a later unrelated Admin status change away from Sold", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Processing);
      const afterSale = await getProductById(db, product.id);
      expect(afterSale.status).toBe(ProductStatus.Sold);
      expect(afterSale.stockQuantity).toBe(0);

      await updateProduct(db, product.id, { status: ProductStatus.Archived });

      const updated = await updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled });
      expect(updated.status).toBe(OrderStatus.Cancelled);

      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(1);
      expect(after.status).toBe(ProductStatus.Archived);

      const rollbackMovements = await listStockMovements(db, {
        productId: product.id,
        page: 1,
        pageSize: 20,
        type: StockMovementType.SaleRollback,
      });
      expect(rollbackMovements.items).toHaveLength(1);
    });

    it("an invalid Shipped -> Cancelled attempt does not restore Inventory", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Shipped);
      await expect(updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).rejects.toBeInstanceOf(
        BadRequestError,
      );
      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(0);
    });

    it("an invalid Completed -> Cancelled attempt does not restore Inventory", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Completed);
      await expect(updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).rejects.toBeInstanceOf(
        BadRequestError,
      );
      const after = await getProductById(db, product.id);
      expect(after.stockQuantity).toBe(0);
    });

    it("rolls back the whole transaction if Inventory restoration fails, leaving Order status unchanged", async () => {
      const { order, product } = await createOrderAtStatus(OrderStatus.Processing);
      // Force restoreInventoryForSaleRollbackInTransactionUseCase's findByProduct
      // lookup to fail by removing the product row it depends on. FK constraints
      // (declared only in the raw schema.sql, not the Drizzle schema) must be
      // relaxed for this one delete since order_items/stock_movements still
      // reference it — that referential integrity isn't what this test targets.
      const sqlite = (db as any).session.client;
      sqlite.pragma("foreign_keys = OFF");
      await db.delete(products).where(eq(products.id, product.id));
      sqlite.pragma("foreign_keys = ON");

      await expect(updateOrderStatus(db, order.id, { status: OrderStatus.Cancelled })).rejects.toThrow();

      const unchanged = await getOrderById(db, order.id);
      expect(unchanged.status).toBe(OrderStatus.Processing);

      // The product row itself was deleted to force this failure, so its status
      // can no longer be read - but the stock-movement ledger is independently
      // queryable and proves no partial SaleRollback movement was left behind.
      const rollbackMovements = await listStockMovements(db, {
        productId: product.id,
        page: 1,
        pageSize: 20,
        type: StockMovementType.SaleRollback,
      });
      expect(rollbackMovements.items).toHaveLength(0);
    });
  });
});

describe("OrderItem image snapshot (Sprint 86)", () => {
  let db: ReturnType<typeof createTestDb>;
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
    const category = await createCategory(db, { name: "Snapshots", displayOrder: 0, isActive: true });
    categoryId = category.id;
  });

  async function seedProduct(sku: string) {
    return createProduct(db, {
      sku,
      title: "Snapshot Test Product",
      slug: `${sku.toLowerCase()}-slug`,
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      stockQuantity: 1,
    });
  }

  async function seedPhoto(productId: string, overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const row = {
      id: `ph-${Math.random().toString(36).slice(2, 10)}`,
      productId,
      url: "/images/product-photos/default.webp",
      thumbnailUrl: "/images/product-photos/default-thumb.webp",
      altText: null,
      sortOrder: 0,
      isPrimary: true,
      filename: "default.webp",
      mimeType: "image/webp",
      sizeBytes: 2048,
      width: 800,
      height: 600,
      processingStatus: "Ready",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    await db.insert(productPhotos).values(row as any);
    return row;
  }

  async function payFor(reference: string) {
    return createPaymentSession(db, {
      provider: PaymentProvider.Stripe,
      providerReference: reference,
      status: PaymentStatus.Paid,
      amount: 100,
      currency: "EUR",
      idempotencyKey: `test:${reference}:${Math.random()}`,
    });
  }

  function orderInput(productId: string, reference: string, overrides: Record<string, unknown> = {}) {
    return {
      orderDraftId: `draft-${reference}`,
      guestEmail: "jane@example.com",
      status: OrderStatus.Pending,
      paymentStatus: PaymentStatus.Paid,
      paymentProvider: PaymentProvider.Stripe,
      paymentReference: reference,
      currency: "EUR" as const,
      billingAddress: address,
      shippingAddress: address,
      subtotalAmount: 100,
      totalAmount: 100,
      items: [{ productId, quantity: 1 as const }],
      ...overrides,
    };
  }

  it("snapshots a Processing Primary ProductPhoto's relative URL", async () => {
    const product = await seedProduct("SKU-SNAP-PROCESSING");
    await seedPhoto(product.id, { id: "ph-processing", processingStatus: "Processing", url: "/images/product-photos/processing.webp", thumbnailUrl: "/images/product-photos/processing-thumb.webp" });
    await payFor("ref-snap-processing");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-processing")));
    expect(order.items[0].productImageUrl).toBe("/images/product-photos/processing.webp");
  });

  it("snapshots a Ready Primary ProductPhoto's relative URL", async () => {
    const product = await seedProduct("SKU-SNAP-READY");
    await seedPhoto(product.id, { id: "ph-ready", processingStatus: "Ready", url: "/images/product-photos/ready.webp", thumbnailUrl: "/images/product-photos/ready-thumb.webp" });
    await payFor("ref-snap-ready");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-ready")));
    expect(order.items[0].productImageUrl).toBe("/images/product-photos/ready.webp");
  });

  it("excludes a Failed ProductPhoto and still allows the order to be created with a null snapshot", async () => {
    const product = await seedProduct("SKU-SNAP-FAILED");
    await seedPhoto(product.id, { id: "ph-failed", processingStatus: "Failed", url: "/images/product-photos/failed.webp", thumbnailUrl: "/images/product-photos/failed-thumb.webp" });
    await payFor("ref-snap-failed");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-failed")));
    expect(order.items[0].productImageUrl ?? null).toBeNull();
  });

  it("selects the Primary photo first even when a non-primary photo has a lower sortOrder", async () => {
    const product = await seedProduct("SKU-SNAP-PRIMARY-ORDER");
    await seedPhoto(product.id, { id: "ph-nonprimary", isPrimary: false, sortOrder: 0, url: "/images/product-photos/nonprimary.webp", thumbnailUrl: "/images/product-photos/nonprimary-thumb.webp" });
    await seedPhoto(product.id, { id: "ph-primary", isPrimary: true, sortOrder: 1, url: "/images/product-photos/primary.webp", thumbnailUrl: "/images/product-photos/primary-thumb.webp" });
    await payFor("ref-snap-primary-order");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-primary-order")));
    expect(order.items[0].productImageUrl).toBe("/images/product-photos/primary.webp");
  });

  it("creates the order successfully with a null/undefined snapshot when the product has no eligible photo", async () => {
    const product = await seedProduct("SKU-SNAP-NONE");
    await payFor("ref-snap-none");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-none")));
    expect(order.items[0].productImageUrl ?? null).toBeNull();
  });

  it("preserves the snapshot after the source ProductPhoto is later deleted", async () => {
    const product = await seedProduct("SKU-SNAP-PERSIST");
    const photo = await seedPhoto(product.id, { id: "ph-persist", url: "/images/product-photos/persist.webp", thumbnailUrl: "/images/product-photos/persist-thumb.webp" });
    await payFor("ref-snap-persist");
    const order = await createOrder(db, createOrderSchema.parse(orderInput(product.id, "ref-snap-persist")));
    expect(order.items[0].productImageUrl).toBe("/images/product-photos/persist.webp");

    await db.delete(productPhotos).where(eq(productPhotos.id, photo.id as string));

    const reread = await getOrderById(db, order.id);
    expect(reread.items[0].productImageUrl).toBe("/images/product-photos/persist.webp");
  });

  describe("repository-level dual-dialect coverage of the corrected ProductPhoto selection query", () => {
    it("SQLite dialect: validateProductReferences returns the Ready/Processing primary photo URL, excluding Failed", async () => {
      const product = await seedProduct("SKU-SNAP-SQLITE");
      await seedPhoto(product.id, { id: "ph-sqlite-failed", isPrimary: false, sortOrder: 0, processingStatus: "Failed", url: "/images/product-photos/sqlite-failed.webp", thumbnailUrl: "/images/product-photos/sqlite-failed-thumb.webp" });
      await seedPhoto(product.id, { id: "ph-sqlite-ready", isPrimary: true, sortOrder: 1, processingStatus: "Ready", url: "/images/product-photos/sqlite-ready.webp", thumbnailUrl: "/images/product-photos/sqlite-ready-thumb.webp" });
      const repos = createDrizzleOrderRepositories(db, sqliteSchema, "sqlite");
      const [ref] = await repos.orderItems.write.validateProductReferences([product.id]);
      expect((ref as any).imageUrl).toBe("/images/product-photos/sqlite-ready.webp");
    });

    it("PostgreSQL dialect: validateProductReferences returns the Ready/Processing primary photo URL, excluding Failed", async () => {
      const product = await seedProduct("SKU-SNAP-POSTGRES");
      await seedPhoto(product.id, { id: "ph-pg-failed", isPrimary: false, sortOrder: 0, processingStatus: "Failed", url: "/images/product-photos/pg-failed.webp", thumbnailUrl: "/images/product-photos/pg-failed-thumb.webp" });
      await seedPhoto(product.id, { id: "ph-pg-processing", isPrimary: true, sortOrder: 1, processingStatus: "Processing", url: "/images/product-photos/pg-processing.webp", thumbnailUrl: "/images/product-photos/pg-processing-thumb.webp" });
      const repos = createDrizzleOrderRepositories(db, postgresSchema, "postgres");
      const [ref] = await repos.orderItems.write.validateProductReferences([product.id]);
      expect((ref as any).imageUrl).toBe("/images/product-photos/pg-processing.webp");
    });
  });
});
