import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/services/errors";
import {
  archiveCategory,
  createCategory,
  restoreCategory,
  seedInitialCategoriesIfEmpty,
} from "../src/services/categories";
import { createTestDb } from "./testDb";

describe("category service", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a category with a derived slug", async () => {
    const category = await createCategory(db, {
      name: "Watches & Timepieces",
      displayOrder: 0,
      isActive: true,
    });
    expect(category.slug).toBe("watches-timepieces");
    expect(category.isActive).toBe(true);
  });

  it("rejects a duplicate category slug", async () => {
    await createCategory(db, { name: "Pens", slug: "pens", displayOrder: 0, isActive: true });
    await expect(
      createCategory(db, { name: "Pens Duplicate", slug: "pens", displayOrder: 1, isActive: true }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("archives and restores a category", async () => {
    const category = await createCategory(db, {
      name: "Collectibles",
      displayOrder: 0,
      isActive: true,
    });

    const archived = await archiveCategory(db, category.id);
    expect(archived.isActive).toBe(false);

    const restored = await restoreCategory(db, category.id);
    expect(restored.isActive).toBe(true);
  });

  it("throws NotFoundError when archiving a missing category", async () => {
    await expect(archiveCategory(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("seeds the initial category list only when the table is empty", async () => {
    const { categories } = await import("../src/db/schema");

    await seedInitialCategoriesIfEmpty(db);
    const afterFirstSeed = await db.select().from(categories);
    expect(afterFirstSeed.length).toBe(7);

    await createCategory(db, { name: "Extra Category", displayOrder: 99, isActive: true });
    await seedInitialCategoriesIfEmpty(db); // should be a no-op now, table is non-empty

    const rows = await db.select().from(categories);
    expect(rows.length).toBe(8);
  });
});
