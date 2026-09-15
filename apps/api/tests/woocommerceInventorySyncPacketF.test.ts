import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BackgroundJobStatus, BackgroundJobType, ProductStatus, PublishChannel, StockSyncStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { saveWooCommerceConnection, verifyWooCommerceConnection, type WooCommerceTransport } from "../src/integrations/woocommerce/connectionClient";
import { enqueueJob, executeJob, runDueJobs } from "../src/services/backgroundJobs";
import { enqueueStockSyncIntent, createStockSyncOutboxDispatcher } from "../src/services/stockSyncOutbox";
import { enqueueProductStockSync, syncExternalListingStock } from "../src/services/stockSync";
import { createTestDb } from "./testDb";

const now = "2026-09-15T00:00:00.000Z";
type TestDb = ReturnType<typeof createTestDb>;
type Response = { status: number; body?: unknown } | Error;

function fakeTransport(initial: Response[] = []) {
  const responses = [...initial];
  const request = vi.fn(async () => { const response = responses.shift(); if (response instanceof Error) throw response; return response ?? { status: 500 }; });
  return { request, responses } satisfies WooCommerceTransport & { responses: Response[] };
}

async function seed(database: TestDb, options: { stock?: number; listingStatus?: string; externalId?: string; connectionStatus?: string } = {}) {
  const stock = options.stock ?? 5;
  await database.insert(schema.products).values({ id: "product-woo", sku: "ART-000001", title: "Moon vase", slug: "moon-vase", type: "unique", status: ProductStatus.Published, stockQuantity: stock, priceEur: 100, createdAt: now, updatedAt: now } as any);
  const verification = fakeTransport([{ status: 200 }]);
  await saveWooCommerceConnection(database, { storeUrl: "https://shop.example.test", consumerKey: "ck_test", consumerSecret: "cs_test" });
  await verifyWooCommerceConnection(database, verification);
  if (options.connectionStatus) await database.update(schema.marketplaceConnections).set({ status: options.connectionStatus }).where(eq(schema.marketplaceConnections.channel, PublishChannel.WooCommerce));
  const [connection] = await database.select().from(schema.marketplaceConnections).where(eq(schema.marketplaceConnections.channel, PublishChannel.WooCommerce));
  await database.insert(schema.externalListings).values({ id: "listing-woo", productId: "product-woo", channel: PublishChannel.WooCommerce, connectionId: connection.id, externalListingId: options.externalId ?? "901", externalStatus: options.listingStatus ?? "publish", payloadSnapshot: "{}", publishedAt: now, updatedAt: now });
  return { connection };
}

function inventoryResponses(remote: number, confirmed: number): Response[] {
  return [{ status: 200, body: { id: 901, stock_quantity: remote } }, { status: 200, body: { id: 901, stock_quantity: confirmed } }];
}

beforeEach(() => {
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  vi.restoreAllMocks();
  vi.spyOn(global, "fetch").mockRejectedValue(new Error("live network disabled"));
});

describe("Packet F WooCommerce inventory convergence", () => {
  it.each([[7, 2], [0, 4]] as const)("synchronizes authoritative quantity %s from remote quantity %s", async (local, remote) => {
    const database = createTestDb(); await seed(database, { stock: local }); const transport = fakeTransport(inventoryResponses(remote, local));
    const result = await syncExternalListingStock(database, "listing-woo", "job-normal", undefined, transport);
    expect(result).toMatchObject({ status: StockSyncStatus.Updated, localStock: local, confirmedMarketplaceStock: local, externalListingId: "901" });
    expect(transport.request.mock.calls.map(([input]) => input.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(transport.request.mock.calls[1]![0].body!)).toEqual({ manage_stock: true, stock_quantity: local });
    expect((await database.select().from(schema.products))[0].stockQuantity).toBe(local);
    expect((await database.select().from(schema.stockSyncAudit))[0]).toMatchObject({ jobId: "job-normal", requestedMarketplaceStock: local, confirmedMarketplaceStock: local, resultStatus: StockSyncStatus.Updated });
  });

  it("converges zero to restock and restock to sellout using current snapshots", async () => {
    const database = createTestDb(); await seed(database, { stock: 0 });
    const transport = fakeTransport([...inventoryResponses(4, 0), ...inventoryResponses(0, 6), ...inventoryResponses(6, 0)]);
    await syncExternalListingStock(database, "listing-woo", "zero", undefined, transport);
    await database.update(schema.products).set({ stockQuantity: 6 }).where(eq(schema.products.id, "product-woo"));
    await syncExternalListingStock(database, "listing-woo", "restock", undefined, transport);
    await database.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, "product-woo"));
    await syncExternalListingStock(database, "listing-woo", "sellout", undefined, transport);
    expect(transport.request.mock.calls.filter(([input]) => input.method === "PUT").map(([input]) => JSON.parse(input.body!).stock_quantity)).toEqual([0, 6, 0]);
  });

  it("skips matching current inventory without an update", async () => {
    const database = createTestDb(); await seed(database, { stock: 3 }); const transport = fakeTransport([{ status: 200, body: { id: 901, stock_quantity: 3 } }]);
    await expect(syncExternalListingStock(database, "listing-woo", "same", undefined, transport)).resolves.toMatchObject({ status: StockSyncStatus.Skipped, confirmedMarketplaceStock: 3 });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing identity, inactive listing, and invalid connection without transport", async () => {
    const missing = createTestDb(); await seed(missing, { externalId: "" }); const missingTransport = fakeTransport();
    await expect(syncExternalListingStock(missing, "listing-woo", undefined, undefined, missingTransport)).rejects.toMatchObject({ type: "Validation", retryable: false });
    expect(missingTransport.request).not.toHaveBeenCalled();

    const inactive = createTestDb(); await seed(inactive, { listingStatus: "ended" }); const inactiveTransport = fakeTransport();
    await expect(syncExternalListingStock(inactive, "listing-woo", undefined, undefined, inactiveTransport)).resolves.toMatchObject({ status: StockSyncStatus.Skipped });
    expect(inactiveTransport.request).not.toHaveBeenCalled();

    const disabled = createTestDb(); await seed(disabled, { connectionStatus: "configured" }); const disabledTransport = fakeTransport();
    await expect(syncExternalListingStock(disabled, "listing-woo", undefined, undefined, disabledTransport)).rejects.toMatchObject({ type: "Authentication", retryable: false });
    expect(disabledTransport.request).not.toHaveBeenCalled();

    const missingConnection = createTestDb(); await seed(missingConnection); (missingConnection as any).$client.pragma("foreign_keys = OFF"); await missingConnection.update(schema.externalListings).set({ connectionId: "missing" }).where(eq(schema.externalListings.id, "listing-woo")); const missingConnectionTransport = fakeTransport();
    await expect(syncExternalListingStock(missingConnection, "listing-woo", undefined, undefined, missingConnectionTransport)).rejects.toMatchObject({ type: "Authentication", retryable: false });
    expect(missingConnectionTransport.request).not.toHaveBeenCalled();
  });

  it("selects the canonical Woo listing when unrelated provider listings coexist", async () => {
    const database = createTestDb(); const { connection } = await seed(database, { stock: 2 });
    await database.insert(schema.externalListings).values({ id: "listing-ebay", productId: "product-woo", channel: PublishChannel.Ebay, connectionId: connection.id, externalListingId: "ebay-1", externalStatus: "active", payloadSnapshot: "{}", publishedAt: now, updatedAt: now });
    const jobs = await enqueueProductStockSync(database, "product-woo", "multi-provider");
    expect(jobs.map((job) => [job.channel, job.externalListingId]).sort()).toEqual([["ebay", "listing-ebay"], ["woocommerce", "listing-woo"]]);
  });

  it.each([[503, BackgroundJobStatus.RetryPending], [400, BackgroundJobStatus.Failed]] as const)("classifies HTTP %s through canonical job retry semantics", async (status, expected) => {
    const database = createTestDb(); await seed(database); const transport = fakeTransport([{ status }]);
    const job = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", payload: { externalListingId: "listing-woo" }, idempotencyKey: `http-${status}` });
    await runDueJobs(database, "worker", 1, transport);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0]).toMatchObject({ status: expected, attemptCount: 1 });
  });

  it("safely retries timeout and converges to the latest canonical quantity", async () => {
    const database = createTestDb(); await seed(database, { stock: 5 }); const transport = fakeTransport([new Error("timeout")]);
    const job = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", payload: { externalListingId: "listing-woo" }, idempotencyKey: "timeout-retry" });
    await runDueJobs(database, "first", 1, transport);
    await database.update(schema.products).set({ stockQuantity: 2 }).where(eq(schema.products.id, "product-woo"));
    await database.update(schema.backgroundJobs).set({ runAfter: "2000-01-01T00:00:00.000Z" }).where(eq(schema.backgroundJobs.id, job.id));
    transport.responses.push(...inventoryResponses(5, 2));
    await runDueJobs(database, "retry", 1, transport);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0]).toMatchObject({ status: BackgroundJobStatus.Succeeded, attemptCount: 1 });
    expect(JSON.parse(transport.request.mock.calls.at(-1)![0].body!).stock_quantity).toBe(2);
  });

  it("materializes durable outbox work after simulated restart and never replays completed work", async () => {
    const database = createTestDb(); await seed(database, { stock: 4 }); enqueueStockSyncIntent(database as any, "product-woo", "movement-restart");
    const dispatcherAfterRestart = createStockSyncOutboxDispatcher(database);
    await dispatcherAfterRestart.dispatchDueEvents("restart", 10);
    const transport = fakeTransport(inventoryResponses(1, 4));
    await runDueJobs(database, "jobs", 10, transport);
    const callsAfterSuccess = transport.request.mock.calls.length;
    await runDueJobs(database, "jobs-again", 10, transport);
    expect(transport.request).toHaveBeenCalledTimes(callsAfterSuccess);
    expect((await database.select().from(schema.outboxEvents))[0].status).toBe("Succeeded");
    expect((await database.select().from(schema.backgroundJobs))[0].status).toBe(BackgroundJobStatus.Succeeded);
  });

  it("prevents older work from leaving stale quantity after rapid changes", async () => {
    const database = createTestDb(); await seed(database, { stock: 5 });
    const older = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", payload: { requestedStock: 4, externalListingId: "listing-woo" }, idempotencyKey: "older" });
    const newer = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", payload: { requestedStock: 3, externalListingId: "listing-woo" }, idempotencyKey: "newer" });
    await database.update(schema.products).set({ stockQuantity: 3 }).where(eq(schema.products.id, "product-woo"));
    const transport = fakeTransport([...inventoryResponses(5, 3), { status: 200, body: { id: 901, stock_quantity: 3 } }]);
    await executeJob(database, { ...newer, status: BackgroundJobStatus.Processing } as any, transport);
    await executeJob(database, { ...older, status: BackgroundJobStatus.Processing } as any, transport);
    expect(transport.request.mock.calls.filter(([input]) => input.method === "PUT").map(([input]) => JSON.parse(input.body!).stock_quantity)).toEqual([3]);
    expect((await database.select().from(schema.products))[0].stockQuantity).toBe(3);
  });

  it("treats malformed success as terminal and never completes falsely", async () => {
    const database = createTestDb(); await seed(database); const transport = fakeTransport([{ status: 200, body: { id: 901 } }]);
    const job = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", idempotencyKey: "malformed" });
    await runDueJobs(database, "worker", 1, transport);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0]).toMatchObject({ status: BackgroundJobStatus.Failed, attemptCount: 1 });
  });

  it("bounds retryable failures with the canonical dead-letter policy", async () => {
    const database = createTestDb(); await seed(database); const transport = fakeTransport([new Error("timeout")]);
    const job = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.WooCommerce, productId: "product-woo", externalListingId: "listing-woo", idempotencyKey: "bounded", maxAttempts: 1 });
    await runDueJobs(database, "worker", 1, transport);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0]).toMatchObject({ status: BackgroundJobStatus.DeadLetter, attemptCount: 1 });
  });
});
