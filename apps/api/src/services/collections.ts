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

export async function listCollections(db: DbClient, query: CollectionListQuery) {
  const conditions = [];
  if (query.search) {
    conditions.push(like(collections.name, `%${query.search}%`));
  }
  if (!query.includeInactive) {
    conditions.push(eq(collections.isActive, true));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(collections)
    .where(whereClause);

  const rows = await db
    .select()
    .from(collections)
    .where(whereClause)
    .orderBy(collections.displayOrder)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map(toCollection),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getCollectionById(db: DbClient, id: string): Promise<Collection> {
  const [row] = await db.select().from(collections).where(eq(collections.id, id));
  if (!row) throw new NotFoundError("Collection not found");
  return toCollection(row);
}

export async function createCollection(
  db: DbClient,
  input: CreateCollectionInput,
): Promise<Collection> {
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);
  await assertSlugAvailable(db, slug);

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(collections).values({
    id,
    name: input.name,
    slug,
    description: input.description,
    coverImageUrl: input.coverImageUrl,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    displayOrder: input.displayOrder,
    isActive: input.isActive,
    createdAt: now,
    updatedAt: now,
  });

  return getCollectionById(db, id);
}

export async function updateCollection(
  db: DbClient,
  id: string,
  input: UpdateCollectionInput,
): Promise<Collection> {
  await getCollectionById(db, id);

  let slug: string | undefined;
  if (input.slug !== undefined) {
    slug = slugify(input.slug);
    await assertSlugAvailable(db, slug, id);
  }

  await db
    .update(collections)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.coverImageUrl !== undefined ? { coverImageUrl: input.coverImageUrl } : {}),
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collections.id, id));

  return getCollectionById(db, id);
}

export async function archiveCollection(db: DbClient, id: string): Promise<Collection> {
  await getCollectionById(db, id);
  await db
    .update(collections)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id));
  return getCollectionById(db, id);
}

export async function restoreCollection(db: DbClient, id: string): Promise<Collection> {
  await getCollectionById(db, id);
  await db
    .update(collections)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id));
  return getCollectionById(db, id);
}
