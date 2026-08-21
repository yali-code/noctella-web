import { and, desc, eq } from "drizzle-orm";
import type { ProductLifecycleOperation, ProductLifecycleTarget } from "@noctella/shared";
import type { DbClient } from "../../db/client";
import { getDatabaseConfig } from "../../db/config";
import type { ProductLifecycleRepository } from "./types";
import { productLifecycleSchema } from "./schema";

const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
function map(row: any): ProductLifecycleOperation { return { ...row, reason: row.reason ?? undefined, completedAt: row.completedAt ? (row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt) : undefined, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt, targetSnapshot: parse<ProductLifecycleTarget[]>(row.targetSnapshot), targetResults: parse<ProductLifecycleTarget[]>(row.targetResults) }; }
const encode = (value: unknown) => getDatabaseConfig().driver === "sqlite" ? JSON.stringify(value) : value;
const valuesForDriver = (values: Record<string, unknown>) => { if (getDatabaseConfig().driver === "sqlite") return values; const out={...values}; for(const key of ["createdAt","updatedAt","completedAt"]) if(typeof out[key]==="string") out[key]=new Date(out[key] as string); return out; };

export function createProductLifecycleRepository(db: DbClient): ProductLifecycleRepository {
  const { externalListings, marketplaceConnections, productLifecycleOperations } = productLifecycleSchema() as any;
  return {
    async getById(id) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.id, id)); return row ? map(row) : undefined; },
    async getByIdempotencyKey(key) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.idempotencyKey, key)); return row ? map(row) : undefined; },
    async getLatest(productId) { const [row] = await (db as any).select().from(productLifecycleOperations).where(eq(productLifecycleOperations.productId, productId)).orderBy(desc(productLifecycleOperations.createdAt)).limit(1); return row ? map(row) : undefined; },
    async getLatestByAction(productId, action) { const [row] = await (db as any).select().from(productLifecycleOperations).where(and(eq(productLifecycleOperations.productId, productId),eq(productLifecycleOperations.action,action))).orderBy(desc(productLifecycleOperations.createdAt)).limit(1); return row ? map(row) : undefined; },
    async create(values) { await (db as any).insert(productLifecycleOperations).values(valuesForDriver({ ...values, targetSnapshot: encode(values.targetSnapshot), targetResults: encode(values.targetResults) })); },
    async update(id, values) { await (db as any).update(productLifecycleOperations).set(valuesForDriver({ ...values, ...(values.targetResults ? { targetResults: encode(values.targetResults) } : {}) })).where(eq(productLifecycleOperations.id, id)); },
    async replaceResultsIfCurrent(id, expected, next) { const changed = await (db as any).update(productLifecycleOperations).set(valuesForDriver({ targetResults: encode(next), updatedAt: new Date().toISOString() })).where(and(eq(productLifecycleOperations.id, id), eq(productLifecycleOperations.targetResults, encode(expected)))).returning({ id: productLifecycleOperations.id }); return changed.length === 1; },
    async getOriginalConnection(connectionId, channel) { const [row] = await (db as any).select().from(marketplaceConnections).where(and(eq(marketplaceConnections.id, connectionId), eq(marketplaceConnections.channel, channel))); return row; },
    async updateExternalListingStatus(productId, internalListingId, status) { await (db as any).update(externalListings).set(valuesForDriver({ externalStatus: status, updatedAt: new Date().toISOString() })).where(and(eq(externalListings.id, internalListingId), eq(externalListings.productId, productId))); },
    async hasNonTerminalExternalListing(productId, terminalStatuses) { const rows = await (db as any).select({ status: externalListings.externalStatus }).from(externalListings).where(eq(externalListings.productId, productId)); const terminal=new Set(terminalStatuses.map((status)=>status.toLowerCase())); return rows.some((row:any)=>!terminal.has(String(row.status).toLowerCase())); },
    async clearSalePause(productId, expectedPausedAt, updatedAt) { const {products}=productLifecycleSchema() as any; const paused=getDatabaseConfig().driver==="sqlite"?expectedPausedAt:new Date(expectedPausedAt); const changed=await (db as any).update(products).set(valuesForDriver({salePausedAt:null,updatedAt})).where(and(eq(products.id,productId),eq(products.salePausedAt,paused))).returning({id:products.id}); return changed.length===1; },
  };
}
export { map as mapProductLifecycleOperation };
