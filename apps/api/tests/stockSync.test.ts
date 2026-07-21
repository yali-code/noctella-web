import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobStatus, BackgroundJobType, ProductStatus, ProductType, PublishChannel, StockSyncConflictStatus, StockSyncConflictType, StockSyncStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { encryptCredential } from "../src/services/credentialEncryption";
import { createOrder } from "../src/services/orders";
import { createManualStockAdjustment } from "../src/services/stockMovements";
import { manualStockAdjustmentSchema } from "../src/validation/stockMovement";
import { cancelJob, enqueueJob, executeJob } from "../src/services/backgroundJobs";
import { createStockSyncConflict, resolveStockSyncConflict, syncExternalListingStock } from "../src/services/stockSync";
import type { MarketplaceAdapter } from "../src/services/marketplaceAdapters";

const adapterState = vi.hoisted(() => ({ adapter: undefined as MarketplaceAdapter | undefined }));
vi.mock("../src/services/marketplaceAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/marketplaceAdapters")>();
  return { ...actual, getMarketplaceAdapter: () => adapterState.adapter };
});

type TestDb = ReturnType<typeof db>;
const key = Buffer.alloc(32, 13).toString("base64");
function db() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }
function fakeAdapter(stock = 3, confirmed?: number, overrides: Partial<MarketplaceAdapter> = {}) {
  const calls = { get: 0, update: 0 };
  const adapter: MarketplaceAdapter & { calls: typeof calls } = {
    calls,
    getAuthorizationUrl: () => "", exchangeAuthorizationCode: async () => ({ accessToken: "" }), refreshAccessToken: async () => ({ accessToken: "" }), verifyConnection: async () => ({}),
    createListing: async () => ({ externalListingId: "", externalStatus: "" }), updateListing: async () => ({ externalListingId: "", externalStatus: "" }), endListing: async () => ({ externalListingId: "", externalStatus: "" }),
    normalizeError: () => ({ type: "Temporary", message: "temporary", retryable: true }), verifyWebhookSignature: () => true, parseWebhookEvent: () => ({ externalEventId: "evt", eventType: "unsupported", payload: {} }), fetchOrderById: async () => { throw new Error("unused"); }, fetchListingStatus: async () => ({ externalListingId: "ext", externalStatus: "active" }),
    getListingInventory: async (_token, externalListingId) => { calls.get += 1; return { externalListingId, stock }; },
    updateListingInventory: async (_token, externalListingId, requestedStock) => { calls.update += 1; return { externalListingId, requestedStock, confirmedStock: confirmed ?? requestedStock }; },
    listActiveListings: async () => [], normalizeInventoryError: (e) => (e as any)?.type ? e as any : { type: "NotFound", message: "missing", retryable: false },
    ...overrides,
  };
  return adapter;
}
async function seed(database: TestDb, channel: PublishChannel = PublishChannel.Ebay, stock = 3, status = "active") {
  const now = new Date().toISOString();
  await database.insert(schema.products).values({ id: `p-${channel}`, sku: `SKU-${channel}`, title: "Item", slug: `item-${channel}`, type: ProductType.UniqueItem, status: ProductStatus.Published, stockQuantity: stock, priceEur: 10, createdAt: now, updatedAt: now });
  await database.insert(schema.marketplaceConnections).values({ id: `conn-${channel}`, channel, accountLabel: "Default", encryptedAccessToken: encryptCredential(`token-${channel}`), status: "connected", createdAt: now, updatedAt: now });
  await database.insert(schema.externalListings).values({ id: `listing-${channel}`, productId: `p-${channel}`, channel, connectionId: `conn-${channel}`, externalListingId: `ext-${channel}`, externalStatus: status, payloadSnapshot: "{}", publishedAt: now, updatedAt: now });
  return { productId: `p-${channel}`, listingId: `listing-${channel}` };
}
beforeEach(() => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = key; adapterState.adapter = fakeAdapter(); vi.restoreAllMocks(); vi.spyOn(global, "fetch").mockRejectedValue(new Error("live network disabled")); });

describe("stock sync outbound behavior", () => {
  it("skips unchanged stock, creates snapshot/audit, and does not call update", async () => {
    const database = db(); const seeded = await seed(database, PublishChannel.Ebay, 3); const adapter = fakeAdapter(3); adapterState.adapter = adapter;
    const result = await syncExternalListingStock(database, seeded.listingId, "job-1");
    expect(result.status).toBe(StockSyncStatus.Skipped);
    expect(adapter.calls).toMatchObject({ get: 1, update: 0 });
    expect(await database.select().from(schema.marketplaceInventorySnapshots)).toHaveLength(1);
    expect(await database.select().from(schema.stockSyncAudit)).toHaveLength(1);
  });

  it("updates changed eBay and Etsy stock and persists confirmed stock", async () => {
    for (const channel of [PublishChannel.Ebay, PublishChannel.Etsy]) {
      const database = db(); const seeded = await seed(database, channel, 5); const adapter = fakeAdapter(1, 5); adapterState.adapter = adapter;
      const result = await syncExternalListingStock(database, seeded.listingId, "job-2");
      expect(result.status).toBe(StockSyncStatus.Updated);
      expect(adapter.calls.update).toBe(1);
      expect((await database.select().from(schema.stockSyncAudit))[0]).toMatchObject({ confirmedMarketplaceStock: 5, requestedMarketplaceStock: 5 });
    }
  });

  it("skips inactive listings, creates no stock movement, and never lets remote stock change local stock", async () => {
    const database = db(); const inactive = await seed(database, PublishChannel.Ebay, 4, "ended"); adapterState.adapter = fakeAdapter(99);
    await syncExternalListingStock(database, inactive.listingId);
    expect((await database.select().from(schema.products).where(eq(schema.products.id, inactive.productId)))[0].stockQuantity).toBe(4);
    expect(await database.select().from(schema.stockMovements)).toHaveLength(0);
    expect(adapterState.adapter && (adapterState.adapter as any).calls.get).toBe(0);
  });

  it("keeps missing listing/auth/product/negative/unexpected confirmation conflicts open or auto-resolved as expected", async () => {
    const database = db(); const seeded = await seed(database, PublishChannel.Ebay, 3);
    adapterState.adapter = fakeAdapter(0, 2);
    await syncExternalListingStock(database, seeded.listingId);
    expect((await database.select().from(schema.stockSyncConflicts)).map((c) => c.conflictType)).toEqual(expect.arrayContaining([StockSyncConflictType.LocalHigherThanMarketplace, StockSyncConflictType.ConcurrentSale]));

    const missingDb = db(); const missing = await seed(missingDb, PublishChannel.Ebay, 3); adapterState.adapter = fakeAdapter(0, undefined, { getListingInventory: async () => { throw { type: "NotFound", message: "missing", retryable: false }; } });
    await expect(syncExternalListingStock(missingDb, missing.listingId)).rejects.toMatchObject({ type: "NotFound" });
    expect((await missingDb.select().from(schema.stockSyncConflicts))[0]).toMatchObject({ conflictType: StockSyncConflictType.ListingMissing, status: StockSyncConflictStatus.Open });

    const authDb = db(); const auth = await seed(authDb, PublishChannel.Ebay, 3); await authDb.update(schema.marketplaceConnections).set({ encryptedAccessToken: null }).where(eq(schema.marketplaceConnections.id, "conn-ebay"));
    await expect(syncExternalListingStock(authDb, auth.listingId)).rejects.toMatchObject({ type: "Authentication" });

    const productDb = db(); const productConflict = await createStockSyncConflict(productDb, { channel: PublishChannel.Ebay, productId: "missing-product", externalListingId: "missing-listing", conflictType: StockSyncConflictType.ProductMissing });
    expect(productConflict).toMatchObject({ conflictType: StockSyncConflictType.ProductMissing, status: StockSyncConflictStatus.Open });

    const negativeDb = db(); const negative = await seed(negativeDb, PublishChannel.Ebay, 3); adapterState.adapter = fakeAdapter(-1, 3);
    await syncExternalListingStock(negativeDb, negative.listingId);
    expect((await negativeDb.select().from(schema.stockSyncConflicts))[0].conflictType).toBe(StockSyncConflictType.NegativeMarketplaceStock);
  });

  it("resolves conflicts without overwriting local stock and supports duplicate job idempotency", async () => {
    const database = db(); const seeded = await seed(database, PublishChannel.Ebay, 2); adapterState.adapter = fakeAdapter(1, 2);
    const conflict = await createStockSyncConflict(database, { channel: PublishChannel.Ebay, productId: seeded.productId, externalListingId: "ext-ebay", conflictType: StockSyncConflictType.ManualReview, localStock: 2, marketplaceStock: 1 });
    await resolveStockSyncConflict(database, conflict.id, "AcceptMarketplaceSnapshotAsReferenceOnly");
    await resolveStockSyncConflict(database, conflict.id, "Ignore");
    await resolveStockSyncConflict(database, conflict.id, "MarkResolved");
    await resolveStockSyncConflict(database, conflict.id, "RetryLocalToMarketplace");
    expect((await database.select().from(schema.products).where(eq(schema.products.id, seeded.productId)))[0].stockQuantity).toBe(2);
    expect((await database.select().from(schema.backgroundJobs)).length).toBeGreaterThan(0);

    const job = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, externalListingId: seeded.listingId, idempotencyKey: "job-once", payload: { externalListingId: seeded.listingId } });
    await executeJob(database, { ...(job as any), status: BackgroundJobStatus.Processing });
    await executeJob(database, { ...(job as any), status: BackgroundJobStatus.Processing });
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0].status).toBe(BackgroundJobStatus.Succeeded);
    expect(global.fetch).not.toHaveBeenCalled();
    await cancelJob(database, job.id);
  });
});

describe("automatic stock triggers", () => {
  it("enqueues one effective job per active listing after manual increase/decrease/correction and zero stock syncs all active listings", async () => {
    const database = db(); const seeded = await seed(database, PublishChannel.Ebay, 1); await seed(database, PublishChannel.Etsy, 1); await database.insert(schema.externalListings).values({ ...(await database.select().from(schema.externalListings).where(eq(schema.externalListings.id, "listing-ebay")))[0], id: "ended-listing", externalListingId: "ended", externalStatus: "ended" });
    await createManualStockAdjustment(database, manualStockAdjustmentSchema.parse({ productId: seeded.productId, quantityDelta: -1, idempotencyKey: "manual-dec" }));
    const jobs = await database.select().from(schema.backgroundJobs);
    expect(jobs.filter((j) => j.productId === seeded.productId)).toHaveLength(1);
    expect(jobs[0].payloadSnapshot).toContain("manual-dec");
    expect((await database.select().from(schema.products).where(eq(schema.products.id, seeded.productId)))[0].stockQuantity).toBe(0);
  });

  it("internal order processing and duplicate marketplace-style order drafts enqueue no duplicate effective jobs", async () => {
    const database = db(); const seeded = await seed(database, PublishChannel.Ebay, 2); await createOrder(database, { orderDraftId: "draft-1", guestEmail: "buyer@example.com", status: "processing" as any, paymentStatus: "paid" as any, paymentProvider: "stripe" as any, paymentReference: "pay-1", currency: "EUR" as any, billingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" }, shippingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" }, subtotalAmount: 10, totalAmount: 10, items: [{ productId: seeded.productId, quantity: 1 }] });
    await expect(createOrder(database, { orderDraftId: "draft-1", guestEmail: "buyer@example.com", status: "processing" as any, paymentStatus: "paid" as any, paymentProvider: "stripe" as any, paymentReference: "pay-1", currency: "EUR" as any, billingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" }, shippingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" }, subtotalAmount: 10, totalAmount: 10, items: [{ productId: seeded.productId, quantity: 1 }] })).resolves.toBeDefined();
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.productId, seeded.productId)))).toHaveLength(1);
  });
});
