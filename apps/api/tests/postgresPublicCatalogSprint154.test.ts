import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.postgres";
import { createProductReadServiceContextForDb } from "../src/repositories/product-read/factory";
import {
  getPublicCategoryBySlug,
  getPublicCollectionBySlug,
  getPublicProductBySlug,
  listArchiveProducts,
  listPublicCategories,
  listPublicCollections,
  listPublicProducts,
  listRelatedProducts,
} from "../src/services/publicCatalog";
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

const describePostgres = postgresTestConfigured ? describe : describe.skip;
let harness: PostgresTestDb | undefined;

function product(id: string, overrides: Partial<typeof schema.products.$inferInsert> = {}): typeof schema.products.$inferInsert {
  const sequence = Number(id.replace(/\D/g, "")) || 0;
  const timestamp = new Date(Date.UTC(2025, 0, 1, 0, sequence));
  return {
    id,
    sku: `SPRINT154-${id}`,
    title: `Sprint 154 ${id}`,
    slug: `sprint-154-${id}`,
    type: "unique",
    status: "published",
    stockQuantity: 1,
    priceEur: "125.500000",
    condition: "Good",
    conditionDescription: "Light cosmetic wear",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describePostgres("Sprint 154 public catalog PostgreSQL runtime parity", () => {
  afterEach(async () => { await harness?.close(); harness = undefined; });

  it("lists only visible products and retrieves an exact slug beyond the former 100-row boundary", async () => {
    harness = await createPostgresTestDb();
    const context = createProductReadServiceContextForDb(harness.db, "postgres");
    const target = product("target", { createdAt: new Date("2024-01-01T00:00:00.000Z"), updatedAt: new Date("2024-01-01T00:00:00.000Z") });
    const fillers = Array.from({ length: 101 }, (_, index) => product(`filler-${index + 1}`));
    await harness.db.insert(schema.products).values([
      target,
      ...fillers,
      product("draft", { status: "draft" }),
      product("paused", { salePausedAt: new Date("2025-02-01T00:00:00.000Z") }),
    ]);

    const listed = await listPublicProducts(harness.db as any, { page: 1, pageSize: 10, sort: "newest" }, context);
    expect(listed.total).toBe(102);
    expect(listed.items).toHaveLength(10);
    expect(listed.items.some((item) => item.id === "draft" || item.id === "paused")).toBe(false);

    const detail = await getPublicProductBySlug(harness.db as any, target.slug, context);
    expect(detail).toMatchObject({ id: "target", priceEur: 125.5, condition: "Good", conditionDescription: "Light cosmetic wear" });
    expect(typeof detail.createdAt).toBe("string");
    expect(typeof detail.isFeatured).toBe("boolean");
  });

  it("preserves related and archive filtering, ordering, exclusion, and limits", async () => {
    harness = await createPostgresTestDb();
    const context = createProductReadServiceContextForDb(harness.db, "postgres");
    await harness.db.insert(schema.categories).values({ id: "category", name: "Cameras", slug: "cameras", isActive: 1 });
    await harness.db.insert(schema.products).values([
      product("current", { categoryId: "category" }),
      product("related-old", { categoryId: "category", createdAt: new Date("2025-01-01T00:00:00.000Z") }),
      product("related-new", { categoryId: "category", createdAt: new Date("2025-02-01T00:00:00.000Z") }),
      product("related-paused", { categoryId: "category", salePausedAt: new Date("2025-03-01T00:00:00.000Z") }),
      product("related-draft", { categoryId: "category", status: "draft" }),
      product("archive-visible", { status: "sold", showInArchiveAfterSale: 1, updatedAt: new Date("2025-04-01T00:00:00.000Z") }),
      product("archive-hidden", { status: "sold", showInArchiveAfterSale: 0 }),
    ]);

    const related = await listRelatedProducts(harness.db as any, "current", "category", 2, context);
    expect(related.map((item) => item.id)).toEqual(["related-new", "related-old"]);

    const archive = await listArchiveProducts(harness.db as any, { page: 1, pageSize: 10 }, context);
    expect(archive.total).toBe(1);
    expect(archive.items.map((item) => item.id)).toEqual(["archive-visible"]);
  });

  it("returns active categories and collections with customer-safe ProductPhoto mapping", async () => {
    harness = await createPostgresTestDb();
    const context = createProductReadServiceContextForDb(harness.db, "postgres");
    await harness.db.insert(schema.categories).values([
      { id: "category-active", name: "Pens", slug: "pens", isActive: 1 },
      { id: "category-inactive", name: "Hidden", slug: "hidden-category", isActive: 0 },
    ]);
    await harness.db.insert(schema.collections).values([
      { id: "collection-active", name: "Curated", slug: "curated", isActive: 1 },
      { id: "collection-inactive", name: "Hidden", slug: "hidden-collection", isActive: 0 },
    ]);
    await harness.db.insert(schema.products).values(product("photo", { categoryId: "category-active", collectionId: "collection-active" }));
    await harness.db.insert(schema.productPhotos).values({
      id: "photo-primary",
      productId: "photo",
      url: "/images/photo.webp",
      thumbnailUrl: "/images/photo-thumb.webp",
      altText: "A fountain pen",
      sortOrder: 0,
      isPrimary: 1,
      filename: "photo.webp",
      mimeType: "image/webp",
      sizeBytes: 100,
      width: 800,
      height: 1000,
      processingStatus: "Ready",
    });

    expect((await listPublicCategories(harness.db as any, context)).map((item) => item.slug)).toEqual(["pens"]);
    expect(await getPublicCategoryBySlug(harness.db as any, "pens", context)).toMatchObject({ id: "category-active", name: "Pens" });
    expect((await listPublicCollections(harness.db as any, context)).map((item) => item.slug)).toEqual(["curated"]);
    expect(await getPublicCollectionBySlug(harness.db as any, "curated", context)).toMatchObject({ id: "collection-active", name: "Curated" });

    const detail = await getPublicProductBySlug(harness.db as any, "sprint-154-photo", context);
    expect(detail).not.toHaveProperty("sku");
    expect(detail.photos).toEqual([{
      id: "photo-primary",
      url: "/images/photo.webp",
      thumbnailUrl: "/images/photo-thumb.webp",
      altText: "A fountain pen",
      sortOrder: 0,
      isPrimary: true,
    }]);
  });
});
