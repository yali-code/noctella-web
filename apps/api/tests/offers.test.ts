import { OfferStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { acceptOffer, createOffer, listOffers, rejectOffer } from "../src/services/offers";
import { BadRequestError, NotFoundError } from "../src/services/errors";
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
});
