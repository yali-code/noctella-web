import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { BackgroundJobType, OrderStatus } from "@noctella/shared";
import type { DbClient } from "../../db/client";
import { backgroundJobs, marketplaceOrders, orderItems, orders } from "../../db/schema";
import { createSqliteShipmentRepositories } from "./sqliteShipmentRepository";
import { createPostgresShipmentRepositories } from "./postgresShipmentRepository";
import { createSqliteShipmentUnitOfWork, createPostgresShipmentUnitOfWork } from "./unitOfWork";
import type { ShipmentCoreContext } from "./useCases";
import { SqliteUnitOfWork } from "../unitOfWork";
import { transitionOrderStatusUseCase } from "../../use-cases/order/useCases";

const one = (rows:any) => Array.isArray(rows) ? rows[0] : rows;
const all = (rows:any) => Array.isArray(rows) ? rows : [];
export function createShipmentCoreContext(db: DbClient): ShipmentCoreContext {
  const driver = process.env.SHIPMENT_REPOSITORY_DRIVER === "postgres" || process.env.SHIPMENT_REPOSITORY_DRIVER === "supabase-postgres" ? "postgres" : "sqlite";
  const uow = driver === "postgres" ? createPostgresShipmentUnitOfWork(db as any, createPostgresShipmentRepositories as any) : createSqliteShipmentUnitOfWork(db as any, createSqliteShipmentRepositories as any);
  return {
    uow: uow as any,
    orders: {
      getOrder: (id:string) => one((db.select().from(orders).where(eq(orders.id, id)) as any).all?.() ?? db.select().from(orders).where(eq(orders.id, id))),
      listOrderItems: (orderId:string) => all((db.select().from(orderItems).where(eq(orderItems.orderId, orderId)) as any).all?.() ?? db.select().from(orderItems).where(eq(orderItems.orderId, orderId))),
      getMarketplaceOrder: (orderId:string) => one((db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)) as any).all?.() ?? db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)))
    },
    clock: { now: () => new Date().toISOString() },
    ids: { newId: () => randomUUID() },
    fulfillment: { enqueueSubmitShipment: (shipment:any) => { db.insert(backgroundJobs).values({ id: randomUUID(), type: BackgroundJobType.SubmitMarketplaceShipment, status: "pending", channel: shipment.channel, payloadSnapshot: JSON.stringify({ shipmentId: shipment.id }), idempotencyKey: `submit-shipment:${shipment.id}`, priority: 0, attemptCount: 0, maxAttempts: 5, runAfter: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).onConflictDoNothing().run(); } },
    // Sprint 40A: reuses the canonical Order transitionOrderStatusUseCase (never re-implemented here) via a
    // post-commit callback. A failed Order transition (e.g. the Order is in a state that can't reach Shipped)
    // must never fail the already-committed Shipment transition, so the rejection is swallowed here.
    orderLifecycle: { markShipped: (orderId:string) => transitionOrderStatusUseCase(new SqliteUnitOfWork(db)).execute({ id: orderId, status: OrderStatus.Shipped }).then(() => undefined, () => undefined) }
  };
}
