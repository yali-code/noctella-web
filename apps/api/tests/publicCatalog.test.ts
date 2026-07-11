import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createCollection } from "../src/services/collections";
import { createProduct, updateProduct } from "../src/services/products";
import {
  getPublicCategoryBySlug,
  getPublicProductBySlug,
  listArchiveProducts,
  listPublicCategories,
  listPublicProducts,
} from "../src/services/publicCatalog";
import { NotFoundError } from "../src/services/errors";
import { createTestDb } from "./testDb";

describe("public catalog service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let collectionId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const collection = await createCollection(db, {
      name: "Gentleman Series",
      displayOrder: 0,
      isActive: true,
    });
    collectionId = collection.id;
  });

  function baseInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
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

  it("only shows Published products in the public list", async () => {
    await createProduct(db, baseInput({ title: "Draft Item", status: ProductStatus.Draft }));
    await createProduct(db, baseInput({ title: "Pending Item", status: ProductStatus.PendingReview }));
    const published = await createProduct(
      db,
      baseInput({ title: "Published Item", status: ProductStatus.Published }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(published.id);
  });

  it("never exposes Draft/PendingReview/Approved/Reserved/Archived/Returned statuses via getPublicProductBySlug", async () => {
    const hiddenStatuses = [
      ProductStatus.Draft,
      ProductStatus.AiPrepared,
      ProductStatus.PendingReview,
      ProductStatus.Approved,
      ProductStatus.Reserved,
      ProductStatus.Archived,
      ProductStatus.Returned,
    ];
    for (const status of hiddenStatuses) {
      const product = await createProduct(
        db,
        baseInput({ sku: `SKU-${status}`, title: `Hidden Item ${status}`, status }),
      );
      await expect(getPublicProductBySlug(db, product.slug)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("does not expose internal fields (sku, purchaseCost, internalNotes) on the public product", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        purchaseCost: 300,
        internalNotes: "Confidential sourcing note",
      }),
    );
    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct).not.toHaveProperty("sku");
    expect(publicProduct).not.toHaveProperty("purchaseCost");
    expect(publicProduct).not.toHaveProperty("internalNotes");
  });

  it("filters by category slug", async () => {
    const otherCategory = await createCategory(db, { name: "Pens", displayOrder: 1, isActive: true });
    await createProduct(
      db,
      baseInput({ title: "Watch", status: ProductStatus.Published, categoryId }),
    );
    await createProduct(
      db,
      baseInput({ title: "Pen", status: ProductStatus.Published, categoryId: otherCategory.id }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      categorySlug: "watches",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Watch");
  });

  it("filters by collection slug", async () => {
    await createProduct(
      db,
      baseInput({ title: "In Collection", status: ProductStatus.Published, collectionId }),
    );
    await createProduct(db, baseInput({ title: "No Collection", status: ProductStatus.Published }));

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      collectionSlug: "gentleman-series",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("In Collection");
  });

  it("searches by title", async () => {
    await createProduct(
      db,
      baseInput({ title: "Art Deco Cigarette Case", status: ProductStatus.Published }),
    );
    await createProduct(db, baseInput({ title: "Fountain Pen", status: ProductStatus.Published }));

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      search: "Cigarette",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Art Deco Cigarette Case");
  });

  it("paginates results", async () => {
    for (let i = 0; i < 3; i++) {
      await createProduct(
        db,
        baseInput({ sku: `SKU-PAGE-${i}`, title: `Item ${i}`, status: ProductStatus.Published }),
      );
    }
    const page1 = await listPublicProducts(db, { page: 1, pageSize: 2, sort: "newest" });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listPublicProducts(db, { page: 2, pageSize: 2, sort: "newest" });
    expect(page2.items).toHaveLength(1);
  });

  it("shows Sold products in the archive only when showInArchiveAfterSale is true", async () => {
    const soldVisible = await createProduct(
      db,
      baseInput({ title: "Sold Visible", status: ProductStatus.Draft, showInArchiveAfterSale: true }),
    );
    await updateProduct(db, soldVisible.id, { status: ProductStatus.Sold });

    const soldHidden = await createProduct(
      db,
      baseInput({ title: "Sold Hidden", status: ProductStatus.Draft, showInArchiveAfterSale: false }),
    );
    await updateProduct(db, soldHidden.id, { status: ProductStatus.Sold });

    const notSold = await createProduct(
      db,
      baseInput({ title: "Not Sold", status: ProductStatus.Published, showInArchiveAfterSale: true }),
    );
    void notSold;

    const archive = await listArchiveProducts(db, { page: 1, pageSize: 20 });
    expect(archive.items).toHaveLength(1);
    expect(archive.items[0].title).toBe("Sold Visible");
  });

  it("filters by isFeatured", async () => {
    await createProduct(
      db,
      baseInput({ title: "Featured Item", status: ProductStatus.Published, isFeatured: true }),
    );
    await createProduct(
      db,
      baseInput({ title: "Regular Item", status: ProductStatus.Published, isFeatured: false }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      isFeatured: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Featured Item");
  });

  it("only lists active categories publicly", async () => {
    await createCategory(db, { name: "Inactive Category", displayOrder: 2, isActive: false });
    const publicCategories = await listPublicCategories(db);
    expect(publicCategories.some((c) => c.name === "Inactive Category")).toBe(false);
    expect(publicCategories.some((c) => c.name === "Watches")).toBe(true);
  });

  it("throws NotFoundError for an inactive category slug", async () => {
    const inactive = await createCategory(db, {
      name: "Hidden Category",
      displayOrder: 3,
      isActive: false,
    });
    await expect(getPublicCategoryBySlug(db, inactive.slug)).rejects.toBeInstanceOf(NotFoundError);
  });
});
