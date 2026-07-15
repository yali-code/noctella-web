import { and, desc, eq, ilike, sql } from "drizzle-orm";
import * as pg from "../../db/schema.postgres";
const one = async (q: any) => (await q.limit?.(1) ?? await q)[0];
export function createPostgresShipmentRepositories(db: any) {
  const shipments: any = {
    getById: (id: string) => one(db.select().from(pg.shipments).where(eq(pg.shipments.id, id))),
    getByOrderId: (orderId: string) => db.select().from(pg.shipments).where(eq((pg.shipments as any).orderId, orderId)).orderBy(desc((pg.shipments as any).createdAt)),
    getByTrackingNumber: (trackingNumber: string) => one(db.select().from(pg.shipments).where(eq((pg.shipments as any).trackingNumber, trackingNumber))),
    getByExternalFulfillmentId: (id: string) => one(db.select().from(pg.shipments).where(eq((pg.shipments as any).externalFulfillmentId, id))),
    list: (q: any = {}) => db.select().from(pg.shipments).orderBy(desc((pg.shipments as any).createdAt)).limit(q.limit ?? 50).offset(q.offset ?? 0),
    search: (term: string) => db.select().from(pg.shipments).where(ilike((pg.shipments as any).trackingNumber, `%${term}%`)).orderBy(desc((pg.shipments as any).createdAt)),
    count: async () => Number((await db.select({ count: sql<number>`count(*)` }).from(pg.shipments))[0]?.count ?? 0),
    listByStatus: (status: string) => db.select().from(pg.shipments).where(eq((pg.shipments as any).status, status)).orderBy(desc((pg.shipments as any).createdAt)),
    listByCarrier: (carrier: string) => db.select().from(pg.shipments).where(eq((pg.shipments as any).carrierCode, carrier)).orderBy(desc((pg.shipments as any).createdAt)),
    listUpdatedSince: (since: string) => db.select().from(pg.shipments).where(sql`${(pg.shipments as any).updatedAt} >= ${since}`).orderBy(desc((pg.shipments as any).updatedAt)),
    getShipmentSummary: (id: string) => one(db.select().from(pg.shipments).where(eq(pg.shipments.id, id))), getShipmentDetailProjection: (id: string) => one(db.select().from(pg.shipments).where(eq(pg.shipments.id, id))),
    create: (row: any) => db.insert(pg.shipments).values(row).returning(), update: (id: string, patch: any) => db.update(pg.shipments).set(patch).where(eq(pg.shipments.id, id)).returning(),
    updateTracking: (id: string, patch: any) => shipments.update(id, patch), updateStatus: (id: string, patch: any) => shipments.update(id, patch), updateDeliveredState: (id: string, patch: any) => shipments.update(id, patch), updateFailureState: (id: string, patch: any) => shipments.update(id, patch), updateCancellationState: (id: string, patch: any) => shipments.update(id, patch), updateReturnedState: (id: string, patch: any) => shipments.update(id, patch),
    findByOrderId: async (id: string) => (await db.select().from(pg.shipments).where(eq((pg.shipments as any).orderId, id)).limit(1))[0], findByTrackingNumber: (trackingNumber: string) => one(db.select().from(pg.shipments).where(eq((pg.shipments as any).trackingNumber, trackingNumber))), findByExternalFulfillmentId: (id: string) => one(db.select().from(pg.shipments).where(eq((pg.shipments as any).externalFulfillmentId, id))),
    getVersionForUpdate: async (id: string) => (await shipments.getById(id))?.updatedAt, updateWithExpectedVersion: (id: string, expected: string, patch: any) => db.update(pg.shipments).set(patch).where(and(eq(pg.shipments.id, id), eq((pg.shipments as any).updatedAt, expected))).returning()
  };
  const events = { getById: (id: string) => one(db.select().from(pg.shipmentEvents).where(eq(pg.shipmentEvents.id, id))), listByShipment: (id: string) => db.select().from(pg.shipmentEvents).where(eq((pg.shipmentEvents as any).shipmentId, id)).orderBy(desc((pg.shipmentEvents as any).createdAt)), listByOrder: (_id: string) => [], countByShipment: async (id: string) => Number((await db.select({ count: sql<number>`count(*)` }).from(pg.shipmentEvents).where(eq((pg.shipmentEvents as any).shipmentId, id)))[0]?.count ?? 0), getLatestByShipment: async (id: string) => (await events.listByShipment(id))[0], append: (row: any) => db.insert(pg.shipmentEvents).values(row).returning(), appendIdempotent: (row: any) => db.insert(pg.shipmentEvents).values(row).onConflictDoNothing().returning(), findByIdempotencyKey: (_key: string) => undefined, listForUpdate: (id: string) => events.listByShipment(id) };

  const items = { listByShipment: (id: string) => db.select().from(pg.shipmentItems).where(eq((pg.shipmentItems as any).shipmentId, id)), create: (row: any) => db.insert(pg.shipmentItems).values(row).returning() };
  const tracking = { listByShipment: (id: string) => db.select().from(pg.shipmentTrackingUpdates).where(eq((pg.shipmentTrackingUpdates as any).shipmentId, id)).orderBy(desc((pg.shipmentTrackingUpdates as any).createdAt)), appendIdempotent: (row: any) => db.insert(pg.shipmentTrackingUpdates).values(row).onConflictDoNothing().returning() };
  return { shipments, events, items, tracking };
}
export const POSTGRES_SHIPMENT_REPOSITORY_KIND = "native-postgres-shipment-repository";
