import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { Collection } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { collections } from "../db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { slugify } from "../validation/common";
import type {
  CollectionListQuery,
  CreateCollectionInput,
  UpdateCollectionInput,
} from "../validation/collection";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import type { ProductReadServiceContext } from "../repositories/product-read/types";
import { createProductWriteServiceContextForDb } from "../repositories/product-write/factory";
import { createCollectionUseCase, updateCollectionUseCase, archiveCollectionUseCase, restoreCollectionUseCase } from "../use-cases/product-write/useCases";


function productWriteUseCaseContext(db: DbClient) {
  const write = createProductWriteServiceContextForDb(db);
  return { unitOfWork: { run: async <T>(work: (context: never) => T | Promise<T>) => work(undefined as never) }, repositories: write.repositories };
}

function toCollection(row: typeof collections.$inferSelect): Collection {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertSlugAvailable(db: DbClient, slug: string, excludeId?: string): Promise<void> {
  const rows = await db.select({ id: collections.id }).from(collections).where(eq(collections.slug, slug));
  const conflict = rows.find((row) => row.id !== excludeId);
  if (conflict) {
    throw new ConflictError(`Collection slug "${slug}" is already in use`);
  }
}

export async function listCollections(db: DbClient, query: CollectionListQuery, context?: ProductReadServiceContext) {
  context ??= createProductReadServiceContextForDb(db);
  const [items, total] = await Promise.all([context.repositories.collections.list(query), context.repositories.collections.count(query)]);
  return { items: items.map(toCollection), total, page: query.page, pageSize: query.pageSize };
}

export async function getCollectionById(db: DbClient, id: string, context?: ProductReadServiceContext): Promise<Collection> {
  context ??= createProductReadServiceContextForDb(db);
  const row = await context.repositories.collections.getById(id);
  if (!row) throw new NotFoundError("Collection not found");
  return toCollection(row);
}

export async function createCollection(
  db: DbClient,
  input: CreateCollectionInput,
): Promise<Collection> {
  const result = await createCollectionUseCase(productWriteUseCaseContext(db), input);
  return getCollectionById(db, result.id);
}

export async function updateCollection(
  db: DbClient,
  id: string,
  input: UpdateCollectionInput,
): Promise<Collection> {
  await updateCollectionUseCase(productWriteUseCaseContext(db), id, input);
  return getCollectionById(db, id);
}

export async function archiveCollection(db: DbClient, id: string): Promise<Collection> {
  await archiveCollectionUseCase(productWriteUseCaseContext(db), id);
  return getCollectionById(db, id);
}

export async function restoreCollection(db: DbClient, id: string): Promise<Collection> {
  await restoreCollectionUseCase(productWriteUseCaseContext(db), id);
  return getCollectionById(db, id);
}
