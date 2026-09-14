import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { backgroundJobs, externalListings, marketplaceConnections, outboxEvents, products, stockMovements } from "../src/db/schema";
import { createInventoryRepositories } from "../src/repositories/inventory/drizzleCore";
import { OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { enqueueStockSyncIntent, MaterializeStockSyncJobsHandler, stockSyncIntentKey } from "../src/services/stockSyncOutbox";
import { enqueueProductStockSync } from "../src/services/stockSync";
import { createTestDb } from "./testDb";

describe("durable stock-sync intent", () => {
  const now = "2026-09-14T00:00:00.000Z";
  const movement = (id: string, key = id) => ({ id, productId: "p1", type: "sale", quantityDelta: -1, stockBefore: 2, stockAfter: 1, orderId: null, orderItemId: null, note: null, idempotencyKey: key, createdAt: now, updatedAt: now });
  const seedProduct = (db: ReturnType<typeof createTestDb>) => db.insert(products).values({ id: "p1", sku: "SYNC-1", title: "Sync Product", slug: "sync-product", type: "unique", status: "draft", stockQuantity: 2, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, createdAt: now, updatedAt: now }).run();
  const seedIntent = async (db: ReturnType<typeof createTestDb>, key = "materialize") => {
    enqueueStockSyncIntent(db as any, "p1", key);
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "p1"));
    return { ...row, payload: JSON.parse(row.payload) } as any;
  };
  const seedListing = (db: ReturnType<typeof createTestDb>, id: string, channel: string, status = "active") => {
    db.insert(marketplaceConnections).values({ id: `connection-${id}`, channel, accountLabel: id, status: "connected", createdAt: now, updatedAt: now }).run();
    db.insert(externalListings).values({ id, productId: "p1", channel, connectionId: `connection-${id}`, externalListingId: `external-${id}`, externalStatus: status, payloadSnapshot: "{}", publishedAt: now, updatedAt: now }).run();
  };

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

  it("completes a valid zero-listing intent without creating work or calling a provider", async () => {
    const db = createTestDb(); seedProduct(db); const event = await seedIntent(db, "zero");
    const network = vi.spyOn(global, "fetch");
    await expect(new MaterializeStockSyncJobsHandler(db as any).handle(event)).resolves.toBeUndefined();
    expect(await db.select().from(backgroundJobs)).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("materializes exactly one deterministic job per active listing and ignores ineligible listings", async () => {
    const db = createTestDb(); seedProduct(db);
    seedListing(db, "listing-ebay", "ebay"); seedListing(db, "listing-etsy", "etsy", "published"); seedListing(db, "listing-ended", "ebay", "ended");
    const event = await seedIntent(db, "many");
    await new MaterializeStockSyncJobsHandler(db as any).handle(event);
    const jobs = await db.select().from(backgroundJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => ({ productId: job.productId, listing: job.externalListingId, channel: job.channel, key: job.idempotencyKey })).sort((a,b) => String(a.listing).localeCompare(String(b.listing)))).toEqual([
      { productId: "p1", listing: "listing-ebay", channel: "ebay", key: `stock:listing-ebay:${event.idempotencyKey}` },
      { productId: "p1", listing: "listing-etsy", channel: "etsy", key: `stock:listing-etsy:${event.idempotencyKey}` },
    ]);
  });

  it("keeps duplicate handler delivery idempotent", async () => {
    const db = createTestDb(); seedProduct(db); seedListing(db, "listing-one", "ebay"); const event = await seedIntent(db, "duplicate");
    const handler = new MaterializeStockSyncJobsHandler(db as any);
    await handler.handle(event); await handler.handle(event);
    expect(await db.select().from(backgroundJobs)).toHaveLength(1);
  });

  it("accepts a pre-existing expected job without creating another", async () => {
    const db = createTestDb(); seedProduct(db); seedListing(db, "listing-existing", "ebay"); const event = await seedIntent(db, "existing");
    await enqueueProductStockSync(db as any, "p1", event.idempotencyKey);
    const before = await db.select().from(backgroundJobs);
    await new MaterializeStockSyncJobsHandler(db as any).handle(event);
    expect(await db.select().from(backgroundJobs)).toEqual(before);
  });

  it("isolates a malformed event from a later valid intent", async () => {
    const db = createTestDb(); seedProduct(db); seedListing(db, "listing-valid", "ebay"); const valid = await seedIntent(db, "valid");
    const handler = new MaterializeStockSyncJobsHandler(db as any);
    await expect(handler.handle({ aggregateId: "", payload: {} } as any)).rejects.toMatchObject({ permanent: true });
    await expect(handler.handle(valid)).resolves.toBeUndefined();
    expect(await db.select().from(backgroundJobs)).toHaveLength(1);
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
