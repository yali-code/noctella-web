import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { BadRequestError, ConflictError } from "../src/services/errors";
import { archiveProduct, createProduct, updateProduct } from "../src/services/products";
import { createProductSchema } from "../src/validation/product";
import { createTestDb } from "./testDb";

describe("product service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, {
      name: "Watches & Timepieces",
      displayOrder: 0,
      isActive: true,
    });
    categoryId = category.id;
  });

  function baseInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: "SKU-001",
      title: "Vintage Chronograph",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 1200,
      ...overrides,
    };
  }

  it("creates a product with a derived slug and default stock", async () => {
    const product = await createProduct(db, baseInput());
    expect(product.slug).toBe("vintage-chronograph");
    expect(product.stockQuantity).toBe(1);
    expect(product.status).toBe(ProductStatus.Draft);
  });

  it("updates a product's title and price", async () => {
    const product = await createProduct(db, baseInput());
    const updated = await updateProduct(db, product.id, { title: "Vintage Chronograph 1960s", priceEur: 1500 });
    expect(updated.title).toBe("Vintage Chronograph 1960s");
    expect(updated.priceEur).toBe(1500);
  });

  it("rejects a duplicate SKU on creation", async () => {
    await createProduct(db, baseInput());
    await expect(createProduct(db, baseInput({ title: "Another Item" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects a duplicate SKU on update", async () => {
    const first = await createProduct(db, baseInput());
    const second = await createProduct(db, baseInput({ sku: "SKU-002", title: "Second Item" }));
    await expect(updateProduct(db, second.id, { sku: first.sku })).rejects.toBeInstanceOf(ConflictError);
  });

  it("archives a product instead of deleting it", async () => {
    const product = await createProduct(db, baseInput());
    const archived = await archiveProduct(db, product.id);
    expect(archived.status).toBe(ProductStatus.Archived);
  });

  it("enforces Unique Item stock quantity cannot exceed 1", async () => {
    await expect(
      createProduct(db, baseInput({ type: ProductType.UniqueItem, stockQuantity: 2 })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("defaults Unique Item stock quantity to 1 when omitted", async () => {
    const product = await createProduct(db, baseInput({ type: ProductType.UniqueItem }));
    expect(product.stockQuantity).toBe(1);
  });

  it("creates a Lot Item with an optional lot item count", async () => {
    const product = await createProduct(
      db,
      baseInput({ sku: "LOT-001", type: ProductType.LotItem, lotItemCount: 12 }),
    );
    expect(product.type).toBe(ProductType.LotItem);
    expect(product.stockQuantity).toBe(1);
    expect(product.lotItemCount).toBe(12);
  });

  it("rejects creation when category does not exist", async () => {
    await expect(
      createProduct(db, baseInput({ categoryId: "missing-category" })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects more than one primary image", async () => {
    await expect(
      createProduct(
        db,
        baseInput({
          images: [
            { url: "https://example.com/a.jpg", sortOrder: 0, isPrimary: true },
            { url: "https://example.com/b.jpg", sortOrder: 1, isPrimary: true },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("zod schema rejects missing required fields with clear messages", () => {
    const result = createProductSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.path.join("."));
      expect(messages).toContain("sku");
      expect(messages).toContain("title");
      expect(messages).toContain("priceEur");
    }
  });

  it("zod schema rejects a non-positive EUR price", () => {
    const result = createProductSchema.safeParse(
      baseInput({ priceEur: 0 }) as unknown as Record<string, unknown>,
    );
    expect(result.success).toBe(false);
  });

  it("creates a product with no marketplace fields and reports all marketplaces not ready", async () => {
    const product = await createProduct(db, baseInput());
    expect(product.marketplaceReadiness.ebay.ready).toBe(false);
    expect(product.marketplaceReadiness.ebay.missingFields).toEqual(
      expect.arrayContaining(["title", "description", "category", "listingPriceEur"]),
    );
    expect(product.marketplaceReadiness.etsy.ready).toBe(false);
    expect(product.marketplaceReadiness.woocommerce.ready).toBe(false);
  });

  it("saves optional eBay/Etsy/WooCommerce fields without requiring them", async () => {
    const product = await createProduct(
      db,
      baseInput({
        ebayTitle: "Vintage Chronograph — 1960s",
        ebayDescription: "A rare find.",
        ebayCategory: "Jewelry & Watches",
        ebayListingPriceEur: 1300,
        etsyTitle: "Vintage Chronograph",
        etsyTags: ["vintage", "watch"],
        wooProductName: "Vintage Chronograph",
      }),
    );
    expect(product.ebayTitle).toBe("Vintage Chronograph — 1960s");
    expect(product.etsyTags).toEqual(["vintage", "watch"]);
    expect(product.wooProductName).toBe("Vintage Chronograph");
    // eBay has all 4 required fields filled -> ready
    expect(product.marketplaceReadiness.ebay.ready).toBe(true);
    // Etsy is missing description + listingPriceEur -> not ready, but doesn't block save
    expect(product.marketplaceReadiness.etsy.ready).toBe(false);
    expect(product.marketplaceReadiness.etsy.missingFields).toEqual(
      expect.arrayContaining(["description", "listingPriceEur"]),
    );
  });

  it("updates marketplace fields independently via updateProduct", async () => {
    const product = await createProduct(db, baseInput());
    const updated = await updateProduct(db, product.id, {
      etsyTitle: "Updated Etsy Title",
      etsyDescription: "Updated description",
      etsyListingPriceEur: 900,
    });
    expect(updated.etsyTitle).toBe("Updated Etsy Title");
    expect(updated.marketplaceReadiness.etsy.ready).toBe(true);
    // eBay untouched and still not ready
    expect(updated.marketplaceReadiness.ebay.ready).toBe(false);
  });
});
