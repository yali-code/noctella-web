import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { orderItems, orders, products } from "../db/schema";
import { enqueueProductStockSync } from "./stockSync";
import { SqliteUnitOfWork, type UnitOfWork } from "./unitOfWork";
import type { ReturnApplicationContext } from "../use-cases/return/useCases";

function one<T>(q: { all?: () => T[] } | Promise<T[]> | T[]): T | undefined {
  if (Array.isArray(q)) return q[0];
  if ("all" in q && q.all) return q.all()[0];
  throw new Error("ASYNC_RETURN_PORT_NOT_SUPPORTED_FOR_SQLITE_CONTEXT");
}

export function createReturnApplicationContext(db: DbClient, unitOfWork: UnitOfWork = new SqliteUnitOfWork(db)): ReturnApplicationContext {
  return {
    unitOfWork,
    ports: {
      getOrder: (id: string) => one(db.select().from(orders).where(eq(orders.id, id)).limit(1) as any),
      getOrderItem: (id: string) => one(db.select().from(orderItems).where(eq(orderItems.id, id)).limit(1) as any),
      getProduct: (id: string) => one(db.select().from(products).where(eq(products.id, id)).limit(1) as any),
      enqueueStockSync: (productId: string, key: string) => { void enqueueProductStockSync(db, productId, key); },
    },
  };
}
