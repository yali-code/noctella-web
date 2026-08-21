import { desc, eq } from "drizzle-orm";
import type { ProductLifecycleOperation, ProductLifecycleTarget } from "@noctella/shared";
import type { DbClient } from "../../db/client";
import { getDatabaseConfig } from "../../db/config";
import type { ProductLifecycleRepository } from "./types";
import { productLifecycleSchema } from "./schema";

const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
function map(row: any): ProductLifecycleOperation { return { ...row, reason: row.reason ?? undefined, completedAt: row.completedAt ? (row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt) : undefined, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt, targetSnapshot: parse<ProductLifecycleTarget[]>(row.targetSnapshot), targetResults: parse<ProductLifecycleTarget[]>(row.targetResults) }; }
const encode = (value: unknown) => getDatabaseConfig().driver === "sqlite" ? JSON.stringify(value) : value;

export function createProductLifecycleRepository(db: DbClient): ProductLifecycleRepository {
  const { productLifecycleOperations } = productLifecycleSchema() as any;
  return {
    async getById(id) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.id, id)); return row ? map(row) : undefined; },
    async getByIdempotencyKey(key) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.idempotencyKey, key)); return row ? map(row) : undefined; },
    async getLatest(productId) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.productId, productId)).orderBy(desc(productLifecycleOperations.createdAt)).limit(1); return row ? map(row) : undefined; },
    async create(values) { await (db as any).insert(productLifecycleOperations).values({ ...values, targetSnapshot: encode(values.targetSnapshot), targetResults: encode(values.targetResults) }); },
    async update(id, values) { await (db as any).update(productLifecycleOperations).set({ ...values, ...(values.targetResults ? { targetResults: encode(values.targetResults) } : {}) }).where(eq(productLifecycleOperations.id, id)); },
  };
}
export { map as mapProductLifecycleOperation };
