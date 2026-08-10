import { and, desc, eq, like, notInArray, sql } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";
export function createSqliteShipmentRepositories(db: any) {
  const shipments: any = {
    getById: (id: string) => db.select().from(schema.shipments).where(eq(schema.shipments.id, id)).get?.() ?? db.select().from(schema.shipments).where(eq(schema.shipments.id, id))[0],
    getByOrderId: (orderId: string) => db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId)).all?.() ?? db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId)),
    getByTrackingNumber: (trackingNumber: string) => db.select().from(schema.shipments).where(eq(schema.shipments.trackingNumber, trackingNumber)).get?.() ?? db.select().from(schema.shipments).where(eq(schema.shipments.trackingNumber, trackingNumber))[0],
    getByExternalFulfillmentId: (id: string) => db.select().from(schema.shipments).where(eq(schema.shipments.externalFulfillmentId, id)).get?.() ?? db.select().from(schema.shipments).where(eq(schema.shipments.externalFulfillmentId, id))[0],
    list: (q: any = {}) => db.select().from(schema.shipments).orderBy(desc(schema.shipments.createdAt)).limit(q.limit ?? q.pageSize ?? 50).offset(q.offset ?? (((q.page ?? 1)-1)*(q.pageSize ?? q.limit ?? 50))).all?.() ?? db.select().from(schema.shipments).orderBy(desc(schema.shipments.createdAt)).limit(q.limit ?? q.pageSize ?? 50).offset(q.offset ?? (((q.page ?? 1)-1)*(q.pageSize ?? q.limit ?? 50))),
    search: (term: string) => db.select().from(schema.shipments).where(like(schema.shipments.trackingNumber, `%${term}%`)).orderBy(desc(schema.shipments.createdAt)).all?.() ?? [],
    count: () => Number((db.select({ count: sql<number>`count(*)` }).from(schema.shipments).get?.() ?? { count: 0 }).count),
    listByStatus: (status: string) => db.select().from(schema.shipments).where(eq(schema.shipments.status, status)).orderBy(desc(schema.shipments.createdAt)).all?.() ?? [],
    listByCarrier: (carrier: string) => db.select().from(schema.shipments).where(eq(schema.shipments.carrierCode, carrier)).orderBy(desc(schema.shipments.createdAt)).all?.() ?? [],
    listUpdatedSince: (since: string) => db.select().from(schema.shipments).where(sql`${schema.shipments.updatedAt} >= ${since}`).orderBy(desc(schema.shipments.updatedAt)).all?.() ?? [],
    getShipmentSummary: (id: string) => db.select().from(schema.shipments).where(eq(schema.shipments.id, id)).get?.(), getShipmentDetailProjection: (id: string) => db.select().from(schema.shipments).where(eq(schema.shipments.id, id)).get?.(),
    create: (row: any) => db.insert(schema.shipments).values(row).run(), update: (id: string, patch: any) => db.update(schema.shipments).set(patch).where(eq(schema.shipments.id, id)).run(),
    updateTracking: (id: string, patch: any) => shipments.update(id, patch), updateStatus: (id: string, patch: any) => shipments.update(id, patch), updateDeliveredState: (id: string, patch: any) => shipments.update(id, patch), updateFailureState: (id: string, patch: any) => shipments.update(id, patch), updateCancellationState: (id: string, patch: any) => shipments.update(id, patch), updateReturnedState: (id: string, patch: any) => shipments.update(id, patch),
    findByOrderId: (orderId: string) => (db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId)).all?.() ?? [])[0], findByTrackingNumber: (trackingNumber: string) => db.select().from(schema.shipments).where(eq(schema.shipments.trackingNumber, trackingNumber)).get?.(), findByExternalFulfillmentId: (id: string) => db.select().from(schema.shipments).where(eq(schema.shipments.externalFulfillmentId, id)).get?.(),
    getVersionForUpdate: (id: string) => shipments.getById(id)?.updatedAt, updateWithExpectedVersion: (id: string, expected: string, patch: any) => db.update(schema.shipments).set(patch).where(and(eq(schema.shipments.id, id), eq(schema.shipments.updatedAt, expected))).run()
  };
  const events = {
    getById: (id: string) => db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.id, id)).get?.(), listByShipment: (id: string) => db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, id)).orderBy(desc(schema.shipmentEvents.createdAt)).all?.() ?? [], listByOrder: (_id: string) => [], countByShipment: (id: string) => Number((db.select({ count: sql<number>`count(*)` }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, id)).get?.() ?? { count: 0 }).count), getLatestByShipment: (id: string) => events.listByShipment(id)[0], append: (row: any) => db.insert(schema.shipmentEvents).values(row).run(), appendIdempotent: (row: any) => { try { return events.append(row); } catch { return undefined; } }, findByIdempotencyKey: (_key: string) => undefined, listForUpdate: (id: string) => events.listByShipment(id)
  };

  const items = { listByShipment: (id: string) => db.select().from(schema.shipmentItems).where(eq(schema.shipmentItems.shipmentId, id)).all?.() ?? db.select().from(schema.shipmentItems).where(eq(schema.shipmentItems.shipmentId, id)), create: (row: any) => db.insert(schema.shipmentItems).values(row).run() };
  const tracking = { listByShipment: (id: string) => db.select().from(schema.shipmentTrackingUpdates).where(eq(schema.shipmentTrackingUpdates.shipmentId, id)).orderBy(desc(schema.shipmentTrackingUpdates.createdAt)).all?.() ?? [], appendIdempotent: (row: any) => db.insert(schema.shipmentTrackingUpdates).values(row).onConflictDoNothing().run() };
  const orders = {
    getById: (id: string) => db.select().from(schema.orders).where(eq(schema.orders.id, id)).get?.(),
    markProcessingOrderShipped: (id: string, updatedAt: string) => Number(db.update(schema.orders).set({ status: "shipped", updatedAt }).where(and(eq(schema.orders.id, id), eq(schema.orders.status, "processing"))).run()?.changes ?? 0) === 1,
    listItems: (orderId: string) => db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).all?.() ?? []
  };
  const packing = {
    getById: (id: string) => db.select().from(schema.packingTasks).where(eq(schema.packingTasks.id, id)).get?.(),
    listReadyByOrder: (orderId: string) => { const rows = db.select().from(schema.packingTasks).where(and(eq(schema.packingTasks.orderId, orderId), eq(schema.packingTasks.status, "ReadyForShipment"))).all?.() ?? []; return rows.length === 1 ? rows : []; },
    listLines: (packingTaskId: string) => db.select().from(schema.packingTaskLines).where(eq(schema.packingTaskLines.packingTaskId, packingTaskId)).all?.() ?? [],
    associateShipment: (packingTaskId: string, shipmentId: string, updatedAt: string) => db.update(schema.packingTasks).set({ shipmentId, updatedAt }).where(eq(schema.packingTasks.id, packingTaskId)).run()
  };
  const jobs = { enqueue: (row: any) => db.insert(schema.backgroundJobs).values(row).onConflictDoNothing().run() };
  const guards = { hasActiveShipment: (orderId: string) => Boolean(db.select({ id: schema.shipments.id }).from(schema.shipments).where(and(eq(schema.shipments.orderId, orderId), notInArray(schema.shipments.status, ["cancelled", "returned"]))).limit(1).get?.()) };
  return { shipments, events, items, tracking, orders, packing, jobs, guards };
}
export const SQLITE_SHIPMENT_REPOSITORY_KIND = "native-sqlite-shipment-repository";
