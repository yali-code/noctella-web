import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ProductStatus,
  ProductType,
  StockMovementType,
} from "@noctella/shared";
import { createDatabaseRuntime } from "../src/db/runtime";
import type { DbClient } from "../src/db/client";
import * as schema from "../src/db/schema";
import { createCategory, seedInitialCategoriesIfEmpty } from "../src/services/categories";
import { createProduct, getProductById, uploadProductPhoto } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createOffer } from "../src/services/offers";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { listStockMovements } from "../src/services/stockMovements";
import { createOrderSchema } from "../src/validation/order";
import type { PhotoStorage } from "../src/services/photoStorage";

/**
 * A fake PhotoStorage so this database-persistence suite can exercise the real
 * uploadProductPhoto() code path (real product_photos row + real outbox_events row) without
 * touching the filesystem - filesystem persistence is a separate concern, covered by
 * productPhotoRestartPersistence.test.ts.
 */
const fakePhotoStorage: PhotoStorage = {
  async saveProductPhoto() {
    return {
      filename: "restart-test.webp",
      url: "/images/product-photos/restart-test.webp",
      thumbnailUrl: "/images/product-photos/restart-test-thumb.webp",
      mimeType: "image/webp",
      sizeBytes: 4,
      width: 10,
      height: 10,
    };
  },
  async deleteProductPhoto() {},
};

const address = { fullName: "Restart Tester", line1: "1 Persistence Way", city: "Paris", postalCode: "75001", country: "FR" };

describe("Sprint 75 real SQLite restart persistence", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    // better-sqlite3 on Windows can hold the file/WAL-sidecar handle open for a brief moment
    // after close() returns; maxRetries/retryDelay absorbs that instead of racing it.
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempDir = undefined;
  });

  it("persists product, inventory, order, offer, payment, stock-movement, and outbox data across two independent runtimes opened against the same file", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-db-restart-"));
    const dbFile = path.join(tempDir, "restart-test.sqlite");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    // ---- "first process run": open the real runtime, run real schema init, persist real data ----
    const first = createDatabaseRuntime(env);
    const dbFirst = first.db as DbClient;

    await seedInitialCategoriesIfEmpty(dbFirst);
    const categoriesAfterFirstSeed = await dbFirst.select().from(schema.categories);
    expect(categoriesAfterFirstSeed.length).toBeGreaterThan(0);

    const category = await createCategory(dbFirst, { name: "Restart Test Category", displayOrder: 0, isActive: true });
    const product = await createProduct(dbFirst, {
      sku: "SKU-RESTART-TEST",
      title: "Restart Test Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 250,
      stockQuantity: 1,
    });

    await createPaymentSession(dbFirst, {
      provider: PaymentProvider.Stripe,
      providerReference: "restart-ref-1",
      status: PaymentStatus.Paid,
      amount: 250,
      currency: "EUR",
      idempotencyKey: "restart-payment-1",
    });
    const order = await createOrder(
      dbFirst,
      createOrderSchema.parse({
        orderDraftId: "restart-draft-1",
        guestEmail: "restart@example.com",
        status: OrderStatus.Pending,
        paymentStatus: PaymentStatus.Paid,
        paymentProvider: PaymentProvider.Stripe,
        paymentReference: "restart-ref-1",
        currency: "EUR",
        billingAddress: address,
        shippingAddress: address,
        subtotalAmount: 250,
        totalAmount: 250,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    );

    const offerProduct = await createProduct(dbFirst, {
      sku: "SKU-RESTART-OFFER",
      title: "Restart Offer Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: true,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      stockQuantity: 1,
    });
    const offer = await createOffer(dbFirst, {
      productId: offerProduct.id,
      customerName: "Restart Tester",
      customerEmail: "restart@example.com",
      offeredAmount: 400,
      currency: "EUR",
    });

    const photo = await uploadProductPhoto(
      dbFirst,
      product.id,
      { buffer: Buffer.from("fake"), mimetype: "image/webp", size: 4 },
      undefined,
      fakePhotoStorage,
    );

    const movementsBeforeRestart = await listStockMovements(dbFirst, { productId: product.id, page: 1, pageSize: 20 });
    const saleMovementBeforeRestart = movementsBeforeRestart.items.find((m) => m.type === StockMovementType.Sale);
    expect(saleMovementBeforeRestart).toBeDefined();
    expect(saleMovementBeforeRestart?.orderId).toBe(order.id);

    const outboxRowsBeforeRestart = await dbFirst.select().from(schema.outboxEvents);
    expect(outboxRowsBeforeRestart).toHaveLength(1);

    const categoriesBeforeRestart = await dbFirst.select().from(schema.categories);

    // ---- clean shutdown, exactly like a real process stop ----
    await first.shutdown();

    // ---- "second process run": a fully independent runtime instance against the same file ----
    const second = createDatabaseRuntime(env);
    const dbSecond = second.db as DbClient;

    // Startup migrations run again on every real process start - must not fail or mutate data.
    // seedInitialCategoriesIfEmpty must be a no-op here (categories already exist from the first
    // run, including the explicit "Restart Test Category" created above) - not just a re-seed-safe
    // check against the initial seed count.
    await seedInitialCategoriesIfEmpty(dbSecond);
    const categoriesAfterSecondSeed = await dbSecond.select().from(schema.categories);
    expect(categoriesAfterSecondSeed).toHaveLength(categoriesBeforeRestart.length);

    const restartedProduct = await getProductById(dbSecond, product.id);
    expect(restartedProduct.title).toBe("Restart Test Product");
    expect(restartedProduct.status).toBe(ProductStatus.Sold);
    expect(restartedProduct.stockQuantity).toBe(0);

    const [restartedOrder] = await dbSecond.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(restartedOrder.orderNumber).toBe(order.orderNumber);
    expect(restartedOrder.totalAmount).toBe(250);
    expect(restartedOrder.paymentStatus).toBe(PaymentStatus.Paid);

    const [restartedOffer] = await dbSecond.select().from(schema.offers).where(eq(schema.offers.id, offer.id));
    expect(restartedOffer.offeredAmount).toBe(400);
    expect(restartedOffer.productId).toBe(offerProduct.id);

    const [restartedPayment] = await dbSecond
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.providerReference, "restart-ref-1"));
    expect(restartedPayment.status).toBe(PaymentStatus.Paid);
    expect(restartedPayment.orderId).toBe(order.id);

    const movementsAfterRestart = await listStockMovements(dbSecond, { productId: product.id, page: 1, pageSize: 20 });
    expect(movementsAfterRestart.items).toHaveLength(movementsBeforeRestart.items.length);
    const saleMovementAfterRestart = movementsAfterRestart.items.find((m) => m.type === StockMovementType.Sale);
    expect(saleMovementAfterRestart?.id).toBe(saleMovementBeforeRestart?.id);

    const outboxRowsAfterRestart = await dbSecond.select().from(schema.outboxEvents);
    expect(outboxRowsAfterRestart).toHaveLength(1);
    expect(outboxRowsAfterRestart[0].id).toBe(outboxRowsBeforeRestart[0].id);
    expect(outboxRowsAfterRestart[0].aggregateId).toBe(photo.id);

    await second.shutdown();
  });

  it("re-running schema initialization against an already-populated file causes no error, no deleted rows, and no duplicate rows", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-db-migration-twice-"));
    const dbFile = path.join(tempDir, "migration-twice-test.sqlite");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    const first = createDatabaseRuntime(env);
    const dbFirst = first.db as DbClient;
    const category = await createCategory(dbFirst, { name: "Migration Twice Category", displayOrder: 0, isActive: true });
    const product = await createProduct(dbFirst, {
      sku: "SKU-MIGRATION-TWICE",
      title: "Migration Twice Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 75,
      stockQuantity: 1,
    });
    await first.shutdown();

    const categoriesBefore = 1;

    // Opening a second runtime against the same populated file runs ensureSchema() again -
    // this must be a pure no-op against existing data (see db/migrate.ts's CREATE TABLE IF NOT
    // EXISTS / PRAGMA table_info guarded ALTER TABLE pattern).
    const second = createDatabaseRuntime(env);
    const dbSecond = second.db as DbClient;

    const categoriesAfterFirstReopen = await dbSecond.select().from(schema.categories);
    expect(categoriesAfterFirstReopen).toHaveLength(categoriesBefore);
    const restartedProduct = await getProductById(dbSecond, product.id);
    expect(restartedProduct.sku).toBe("SKU-MIGRATION-TWICE");
    expect(restartedProduct.stockQuantity).toBe(1);
    await second.shutdown();

    // A third runtime against the same file - schema init has now run three times total against
    // this one file - must still be a no-op.
    const third = createDatabaseRuntime(env);
    const dbThird = third.db as DbClient;
    const categoriesAfterSecondReopen = await dbThird.select().from(schema.categories);
    expect(categoriesAfterSecondReopen).toHaveLength(categoriesBefore);
    const products = await dbThird.select().from(schema.products).where(eq(schema.products.sku, "SKU-MIGRATION-TWICE"));
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe("Migration Twice Product");
    await third.shutdown();
  });
});
