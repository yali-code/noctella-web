import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { Category } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories } from "../db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { slugify } from "../validation/common";
import type { CategoryListQuery, CreateCategoryInput, UpdateCategoryInput } from "../validation/category";

/** Seeded only when the categories table is empty (Sprint 2 spec §3). */
const INITIAL_CATEGORY_NAMES = [
  "Cameras & Optics",
  "Watches & Timepieces",
  "Pens & Writing",
  "Collectibles",
  "Decorative Objects",
  "Gentleman Series",
  "Archive / Sold Gallery",
];

function toCategory(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    parentId: row.parentId ?? undefined,
    displayImageUrl: row.displayImageUrl ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function seedInitialCategoriesIfEmpty(db: DbClient): Promise<void> {
  const existing = await db.select({ id: categories.id }).from(categories).limit(1);
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  for (const [index, name] of INITIAL_CATEGORY_NAMES.entries()) {
    await db.insert(categories).values({
      id: randomUUID(),
      name,
      slug: slugify(name),
      displayOrder: index,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function assertSlugAvailable(db: DbClient, slug: string, excludeId?: string): Promise<void> {
  const rows = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug));
  const conflict = rows.find((row) => row.id !== excludeId);
  if (conflict) {
    throw new ConflictError(`Category slug "${slug}" is already in use`);
  }
}

export async function listCategories(db: DbClient, query: CategoryListQuery) {
  const conditions = [];
  if (query.search) {
    conditions.push(like(categories.name, `%${query.search}%`));
  }
  if (!query.includeInactive) {
    conditions.push(eq(categories.isActive, true));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(categories)
    .where(whereClause);

  const rows = await db
    .select()
    .from(categories)
    .where(whereClause)
    .orderBy(categories.displayOrder)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map(toCategory),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getCategoryById(db: DbClient, id: string): Promise<Category> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  if (!row) throw new NotFoundError("Category not found");
  return toCategory(row);
}

export async function createCategory(db: DbClient, input: CreateCategoryInput): Promise<Category> {
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);
  await assertSlugAvailable(db, slug);

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(categories).values({
    id,
    name: input.name,
    slug,
    description: input.description,
    parentId: input.parentId,
    displayImageUrl: input.displayImageUrl,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    displayOrder: input.displayOrder,
    isActive: input.isActive,
    createdAt: now,
    updatedAt: now,
  });

  return getCategoryById(db, id);
}

export async function updateCategory(
  db: DbClient,
  id: string,
  input: UpdateCategoryInput,
): Promise<Category> {
  await getCategoryById(db, id); // 404 if missing

  let slug: string | undefined;
  if (input.slug !== undefined) {
    slug = slugify(input.slug);
    await assertSlugAvailable(db, slug, id);
  }

  await db
    .update(categories)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.displayImageUrl !== undefined ? { displayImageUrl: input.displayImageUrl } : {}),
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(categories.id, id));

  return getCategoryById(db, id);
}

export async function archiveCategory(db: DbClient, id: string): Promise<Category> {
  await getCategoryById(db, id);
  await db
    .update(categories)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(categories.id, id));
  return getCategoryById(db, id);
}

export async function restoreCategory(db: DbClient, id: string): Promise<Category> {
  await getCategoryById(db, id);
  await db
    .update(categories)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(eq(categories.id, id));
  return getCategoryById(db, id);
}
