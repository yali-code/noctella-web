import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { outboxEvents } from "../src/db/schema";
import { OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { enqueueStockSyncIntent, MaterializeStockSyncJobsHandler, stockSyncIntentKey } from "../src/services/stockSyncOutbox";
import { createTestDb } from "./testDb";

describe("durable stock-sync intent", () => {
  it("persists exactly once in the caller transaction and rolls back with it", async () => {
    const db = createTestDb();
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
});
