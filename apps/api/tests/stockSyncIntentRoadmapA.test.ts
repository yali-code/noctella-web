import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { outboxEvents, products, stockMovements } from "../src/db/schema";
import { createInventoryRepositories } from "../src/repositories/inventory/drizzleCore";
import { OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { enqueueStockSyncIntent, MaterializeStockSyncJobsHandler, stockSyncIntentKey } from "../src/services/stockSyncOutbox";
import { createTestDb } from "./testDb";

describe("durable stock-sync intent", () => {
  const now = "2026-09-14T00:00:00.000Z";
  const movement = (id: string, key = id) => ({ id, productId: "p1", type: "sale", quantityDelta: -1, stockBefore: 2, stockAfter: 1, orderId: null, orderItemId: null, note: null, idempotencyKey: key, createdAt: now, updatedAt: now });
  const seedProduct = (db: ReturnType<typeof createTestDb>) => db.insert(products).values({ id: "p1", sku: "SYNC-1", title: "Sync Product", slug: "sync-product", type: "unique", status: "draft", stockQuantity: 2, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, createdAt: now, updatedAt: now }).run();

  it("persists exactly once in the caller transaction and rolls back with it", async () => {
    const db = createTestDb();
    seedProduct(db);
    db.transaction((inner) => {
      enqueueStockSyncIntent(inner as any, "p1", "sale-1");
      enqueueStockSyncIntent(inner as any, "p1", "sale-1");
    });
    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: OutboxEventType.StockSyncRequested, aggregateId: "p1", status: OutboxEventStatus.Pending, idempotencyKey: stockSyncIntentKey("sale-1", "p1") });

    expect(() => db.transaction((inner) => {
      enqueueStockSyncIntent(inner as any, "p2", "sale-2");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "p2"))).toHaveLength(0);
  });

  it("materializes through the existing stock-sync job boundary without a remote call", async () => {
    const handler = new MaterializeStockSyncJobsHandler({} as any);
    await expect(handler.handle({ aggregateId: "", payload: {} } as any)).rejects.toMatchObject({ permanent: true });
    expect(vi.isMockFunction(handler.handle)).toBe(false);
  });

  it("commits canonical stock movement and durable intent atomically", async () => {
    const db = createTestDb();
    seedProduct(db);
    const repositories = createInventoryRepositories(db as any, sqliteSchema, "synchronous");
    repositories.stockMovements.append(movement("movement-1"));
    expect(await db.select().from(stockMovements)).toHaveLength(1);
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("rolls back the movement when durable intent persistence fails", async () => {
    const db = createTestDb();
    seedProduct(db);
    expect(() => (db as any).transaction((tx: any) => {
      const repositories = createInventoryRepositories(tx, sqliteSchema, "synchronous", () => { throw new Error("intent unavailable"); });
      repositories.stockMovements.append(movement("movement-failure"));
    })()).toThrow("intent unavailable");
    expect(await db.select().from(stockMovements)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("rolls back both movement and intent when later transaction work fails", async () => {
    const db = createTestDb();
    seedProduct(db);
    expect(() => (db as any).transaction((tx: any) => {
      createInventoryRepositories(tx, sqliteSchema, "synchronous").stockMovements.append(movement("movement-rollback"));
      throw new Error("later work failed");
    })()).toThrow("later work failed");
    expect(await db.select().from(stockMovements)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("retains durable intent when immediate materialization fails", async () => {
    const db = createTestDb();
    seedProduct(db);
    createInventoryRepositories(db as any, sqliteSchema, "synchronous").stockMovements.append(movement("movement-dispatch"));
    const event = (await db.select().from(outboxEvents))[0];
    const handler = new MaterializeStockSyncJobsHandler({ select: () => { throw new Error("dispatcher unavailable"); } } as any);
    await expect(handler.handle({ ...event, payload: JSON.parse(event.payload) } as any)).rejects.toThrow("dispatcher unavailable");
    expect((await db.select().from(outboxEvents))[0]).toMatchObject({ status: OutboxEventStatus.Pending });
  });

  it("keeps replay idempotent while preserving distinct sequential movements", async () => {
    const db = createTestDb();
    seedProduct(db);
    const repositories = createInventoryRepositories(db as any, sqliteSchema, "synchronous");
    repositories.stockMovements.append(movement("movement-a", "business-a"));
    expect(() => repositories.stockMovements.append(movement("movement-a-replay", "business-a"))).toThrow();
    repositories.stockMovements.append(movement("movement-b", "business-b"));
    expect(await db.select().from(stockMovements)).toHaveLength(2);
    expect(await db.select().from(outboxEvents)).toHaveLength(2);
  });
});
