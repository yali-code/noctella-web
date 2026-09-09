import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "../src/services/errors";
import {
  archiveCategory,
  createCategory,
  restoreCategory,
  seedInitialCategoriesIfEmpty,
} from "../src/services/categories";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import { categories } from "../src/db/schema";

const canonicalCategories = [
  ["Cameras & Optics", "cameras-optics", 0],
  ["Watches & Timepieces", "watches-timepieces", 1],
  ["Pens & Writing", "pens-writing", 2],
  ["Collectibles", "collectibles", 3],
  ["Decorative Objects", "decorative-objects", 4],
  ["Gentleman Series", "gentleman-series", 5],
  ["Archive / Sold Gallery", "archive-sold-gallery", 6],
] as const;

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

  it("seeds the exact canonical list once when the table is empty", async () => {
    await seedInitialCategoriesIfEmpty(db);
    const afterFirstSeed = await db.select().from(categories).orderBy(categories.displayOrder);
    expect(afterFirstSeed.map(({ name, slug, displayOrder, isActive }) => ({ name, slug, displayOrder, isActive }))).toEqual(
      canonicalCategories.map(([name, slug, displayOrder]) => ({ name, slug, displayOrder, isActive: true })),
    );

    await seedInitialCategoriesIfEmpty(db);
    expect(await db.select().from(categories)).toEqual(afterFirstSeed);
  });

  it("leaves an existing nonempty category table untouched", async () => {
    await createCategory(db, { name: "User Category", displayOrder: 99, isActive: false });
    const beforeSeed = await db.select().from(categories);
    await seedInitialCategoriesIfEmpty(db);
    expect(await db.select().from(categories)).toEqual(beforeSeed);
  });

  it("submits all canonical categories through one bulk insert", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values }));
    const fakeDb = {
      select: () => ({ from: () => ({ limit: async () => [] }) }),
      insert,
    };

    await seedInitialCategoriesIfEmpty(fakeDb as never);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toHaveLength(7);
  });

  it("leaves no partial canonical rows when the bulk statement fails", async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    sqlite.exec(`CREATE TRIGGER fail_canonical_seed BEFORE INSERT ON categories
      WHEN NEW.name = 'Collectibles' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    const failingDb = drizzle(sqlite);

    await expect(seedInitialCategoriesIfEmpty(failingDb as never)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM categories").get()).toEqual({ count: 0 });
    sqlite.close();
  });
});
