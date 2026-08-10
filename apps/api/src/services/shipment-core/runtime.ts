import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { marketplaceOrders } from "../../db/schema";
import { createSqliteShipmentRepositories } from "./sqliteShipmentRepository";
import { createPostgresShipmentRepositories } from "./postgresShipmentRepository";
import { createSqliteShipmentUnitOfWork, createPostgresShipmentUnitOfWork } from "./unitOfWork";
import type { ShipmentCoreContext } from "./useCases";

const one = (rows:any) => Array.isArray(rows) ? rows[0] : rows;
const all = (rows:any) => Array.isArray(rows) ? rows : [];
export function createShipmentCoreContext(db: DbClient): ShipmentCoreContext {
  const driver = process.env.SHIPMENT_REPOSITORY_DRIVER === "postgres" || process.env.SHIPMENT_REPOSITORY_DRIVER === "supabase-postgres" ? "postgres" : "sqlite";
  const uow = driver === "postgres" ? createPostgresShipmentUnitOfWork(db as any, createPostgresShipmentRepositories as any) : createSqliteShipmentUnitOfWork(db as any, createSqliteShipmentRepositories as any);
  return {
    uow: uow as any,
    marketplace: { getOrder: (orderId:string) => one((db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)) as any).all?.() ?? db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId))) },
    clock: { now: () => new Date().toISOString() },
    ids: { newId: () => randomUUID() }
  };
}
