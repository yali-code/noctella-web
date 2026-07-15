import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { Category } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories } from "../db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { slugify } from "../validation/common";
import type { CategoryListQuery, CreateCategoryInput, UpdateCategoryInput } from "../validation/category";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import type { ProductReadServiceContext } from "../repositories/product-read/types";
import { createProductWriteServiceContextForDb } from "../repositories/product-write/factory";
import { createCategoryUseCase, updateCategoryUseCase, archiveCategoryUseCase, restoreCategoryUseCase } from "../use-cases/product-write/useCases";

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


function productWriteUseCaseContext(db: DbClient) {
  const write = createProductWriteServiceContextForDb(db);
  return { unitOfWork: { run: async <T>(work: (context: never) => T | Promise<T>) => work(undefined as never) }, repositories: write.repositories };
}

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

export async function listCategories(db: DbClient, query: CategoryListQuery, context?: ProductReadServiceContext) {
  context ??= createProductReadServiceContextForDb(db);
  const [items, total] = await Promise.all([context.repositories.categories.list(query), context.repositories.categories.count(query)]);
  return { items: items.map(toCategory), total, page: query.page, pageSize: query.pageSize };
}

export async function getCategoryById(db: DbClient, id: string, context?: ProductReadServiceContext): Promise<Category> {
  context ??= createProductReadServiceContextForDb(db);
  const row = await context.repositories.categories.getById(id);
  if (!row) throw new NotFoundError("Category not found");
  return toCategory(row);
}

export async function createCategory(db: DbClient, input: CreateCategoryInput): Promise<Category> {
  const result = await createCategoryUseCase(productWriteUseCaseContext(db), input);
  return getCategoryById(db, result.id);
}

export async function updateCategory(
  db: DbClient,
  id: string,
  input: UpdateCategoryInput,
): Promise<Category> {
  await updateCategoryUseCase(productWriteUseCaseContext(db), id, input);
  return getCategoryById(db, id);
}

export async function archiveCategory(db: DbClient, id: string): Promise<Category> {
  await archiveCategoryUseCase(productWriteUseCaseContext(db), id);
  return getCategoryById(db, id);
}

export async function restoreCategory(db: DbClient, id: string): Promise<Category> {
  await restoreCategoryUseCase(productWriteUseCaseContext(db), id);
  return getCategoryById(db, id);
}
