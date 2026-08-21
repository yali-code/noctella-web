import { OfferStatus, OrderStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { acceptOffer, createDraftOrderFromOffer, createOffer, listOffers, rejectOffer } from "../src/services/offers";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import { createOfferSchema } from "../src/validation/offer";
import { createTestDb } from "./testDb";

describe("offer service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    const category = await createCategory((db = createTestDb()), {
      name: "Watches",
      displayOrder: 0,
      isActive: true,
    });
    categoryId = category.id;
  });

  function baseProductInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: "SKU-OFFER-001",
      title: "Vintage Chronograph",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: true,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 1200,
      stockQuantity: 1,
      ...overrides,
    };
  }

  function baseOfferInput(productId: string, overrides: Record<string, unknown> = {}) {
    return {
      productId,
      customerName: "Jane Collector",
      customerEmail: "jane@example.com",
      offeredAmount: 900,
      currency: "EUR" as const,
      ...overrides,
    };
  }

  it("creates an offer on a published product that allows offers", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    expect(offer.status).toBe(OfferStatus.Pending);
    expect(offer.offeredAmount).toBe(900);
  });

  it("blocks new and pre-existing offer sales after Pause without deleting history or mutating inventory",async()=>{const product=await createProduct(db,baseProductInput()),before={product:await getProductById(db,product.id),movements:(await db.select().from(schema.stockMovements)).length,reservations:(await db.select().from(schema.stockReservations)).length},pending=await createOffer(db,baseOfferInput(product.id));await db.update(schema.products).set({salePausedAt:new Date().toISOString()}).where(eq(schema.products.id,product.id));await expect(createOffer(db,baseOfferInput(product.id))).rejects.toBeInstanceOf(BadRequestError);await expect(acceptOffer(db,pending.id)).rejects.toBeInstanceOf(BadRequestError);expect((await listOffers(db)).map(o=>o.id)).toContain(pending.id);await db.update(schema.products).set({salePausedAt:null}).where(eq(schema.products.id,product.id));await acceptOffer(db,pending.id);await db.update(schema.products).set({salePausedAt:new Date().toISOString()}).where(eq(schema.products.id,product.id));await expect(createDraftOrderFromOffer(db,pending.id)).rejects.toBeInstanceOf(ConflictError);const after=await getProductById(db,product.id);expect(after.stockQuantity).toBe(before.product.stockQuantity);expect(after.sku).toBe(before.product.sku);expect(after.purchaseCost).toBe(before.product.purchaseCost);expect(await db.select().from(schema.stockMovements)).toHaveLength(before.movements);expect(await db.select().from(schema.stockReservations)).toHaveLength(before.reservations);expect(await db.select().from(schema.orders)).toHaveLength(0);});

  it("rejects an offer on a non-Published product", async () => {
    const product = await createProduct(db, baseProductInput({ status: ProductStatus.Draft }));
    await expect(createOffer(db, baseOfferInput(product.id))).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects an offer when allowMakeOffer is false", async () => {
    const product = await createProduct(db, baseProductInput({ allowMakeOffer: false }));
    await expect(createOffer(db, baseOfferInput(product.id))).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects an offer for a nonexistent product", async () => {
    await expect(createOffer(db, baseOfferInput("does-not-exist"))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("zod schema rejects a non-positive offer amount", () => {
    const result = createOfferSchema.safeParse(baseOfferInput("any-id", { offeredAmount: 0 }));
    expect(result.success).toBe(false);
  });

  it("zod schema rejects an invalid email", () => {
    const result = createOfferSchema.safeParse(baseOfferInput("any-id", { customerEmail: "not-an-email" }));
    expect(result.success).toBe(false);
  });

  it("zod schema rejects a non-EUR currency", () => {
    const result = createOfferSchema.safeParse(baseOfferInput("any-id", { currency: "USD" }));
    expect(result.success).toBe(false);
  });

  it("creating an offer never reserves the product, changes stock, or changes price", async () => {
    const product = await createProduct(db, baseProductInput({ priceEur: 1200, stockQuantity: 1 }));
    await createOffer(db, baseOfferInput(product.id, { offeredAmount: 950 }));

    const unchanged = await getProductById(db, product.id);
    expect(unchanged.status).toBe(ProductStatus.Published);
    expect(unchanged.stockQuantity).toBe(1);
    expect(unchanged.priceEur).toBe(1200);
  });

  it("lists offers", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    const items = await listOffers(db);
    expect(items.map((o) => o.id)).toContain(offer.id);
  });

  it("accepts a pending offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    const accepted = await acceptOffer(db, offer.id);
    expect(accepted.status).toBe(OfferStatus.Accepted);
  });

  it("rejects a pending offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    const rejected = await rejectOffer(db, offer.id);
    expect(rejected.status).toBe(OfferStatus.Rejected);
  });

  it("rejects accepting an already accepted offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    await acceptOffer(db, offer.id);
    await expect(acceptOffer(db, offer.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects rejecting an already rejected offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    await rejectOffer(db, offer.id);
    await expect(rejectOffer(db, offer.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("accept/reject reject an unknown offer id", async () => {
    await expect(acceptOffer(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    await expect(rejectOffer(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepting an offer never touches product stock or price", async () => {
    const product = await createProduct(db, baseProductInput({ priceEur: 1200, stockQuantity: 1 }));
    const offer = await createOffer(db, baseOfferInput(product.id));
    await acceptOffer(db, offer.id);

    const unchanged = await getProductById(db, product.id);
    expect(unchanged.status).toBe(ProductStatus.Published);
    expect(unchanged.stockQuantity).toBe(1);
    expect(unchanged.priceEur).toBe(1200);
  });

  it("creates a Draft Order from an accepted offer, linked and copied from the offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    await acceptOffer(db, offer.id);

    const order = await createDraftOrderFromOffer(db, offer.id);
    expect(order.status).toBe(OrderStatus.Draft);
    expect(order.totalAmount).toBe(900);
    expect(order.currency).toBe("EUR");
    expect(order.items).toHaveLength(1);
    expect(order.items[0].productId).toBe(product.id);
  });

  it("rejects creating a second Draft Order for the same offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    await acceptOffer(db, offer.id);
    await createDraftOrderFromOffer(db, offer.id);

    await expect(createDraftOrderFromOffer(db, offer.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects creating a Draft Order from a pending offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));

    await expect(createDraftOrderFromOffer(db, offer.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects creating a Draft Order from a rejected offer", async () => {
    const product = await createProduct(db, baseProductInput());
    const offer = await createOffer(db, baseOfferInput(product.id));
    await rejectOffer(db, offer.id);

    await expect(createDraftOrderFromOffer(db, offer.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects creating a Draft Order for an unknown offer id", async () => {
    await expect(createDraftOrderFromOffer(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creating a Draft Order never touches product stock, price, or status", async () => {
    const product = await createProduct(db, baseProductInput({ priceEur: 1200, stockQuantity: 1 }));
    const offer = await createOffer(db, baseOfferInput(product.id));
    await acceptOffer(db, offer.id);
    await createDraftOrderFromOffer(db, offer.id);

    const unchanged = await getProductById(db, product.id);
    expect(unchanged.status).toBe(ProductStatus.Published);
    expect(unchanged.stockQuantity).toBe(1);
    expect(unchanged.priceEur).toBe(1200);
  });
});
