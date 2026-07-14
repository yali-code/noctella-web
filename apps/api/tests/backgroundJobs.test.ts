import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { BackgroundJobStatus, BackgroundJobType, PublishChannel, StockSyncStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { cancelJob, claimJobs, completeJob, enqueueJob, failJob, listJobs, recoverStaleJobs, retryJob } from "../src/services/backgroundJobs";

type TestDb = ReturnType<typeof db>;
function db() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }

function tableInfo(sqlite: Database.Database, table: string) { return sqlite.prepare(`PRAGMA table_info(${table})`).all(); }
function indexNames(sqlite: Database.Database, table: string) { return sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>; }

describe("Sprint 13 stock-sync schema", () => {
  it("keeps clean and upgraded DBs equivalent with required unique keys and indexes", () => {
    const clean = new Database(":memory:"); ensureSchema(clean);
    const upgraded = new Database(":memory:"); ensureSchema(upgraded);
    upgraded.exec("DROP TABLE background_jobs; DROP TABLE marketplace_inventory_snapshots; DROP TABLE stock_sync_conflicts; DROP TABLE stock_sync_audit;");
    ensureSchema(upgraded);
    for (const table of ["background_jobs", "marketplace_inventory_snapshots", "stock_sync_conflicts", "stock_sync_audit"]) {
      expect(tableInfo(clean, table).map((r: any) => r.name)).toEqual(tableInfo(upgraded, table).map((r: any) => r.name));
    }
    expect(indexNames(clean, "background_jobs")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sqlite_autoindex_background_jobs_2", unique: 1 }),
      expect.objectContaining({ name: "idx_background_jobs_status_run" }),
      expect.objectContaining({ name: "idx_background_jobs_type" }),
      expect.objectContaining({ name: "idx_background_jobs_channel" }),
      expect.objectContaining({ name: "idx_background_jobs_product" }),
      expect.objectContaining({ name: "idx_background_jobs_external_listing" }),
    ]));
    expect(indexNames(clean, "stock_sync_conflicts")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "idx_stock_sync_conflicts_open" })]));
  });
});

describe("background job queue", () => {
  it("enqueues idempotently, claims due jobs only, locks atomically, filters, retries, cancels and preserves audit", async () => {
    const database = db();
    const now = "2026-07-14T00:00:00.000Z";
    const first = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.Ebay, productId: "p1", externalListingId: "l1", idempotencyKey: "same", payload: { productId: "p1" }, runAfter: now });
    const dup = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "same", payload: { productId: "other" }, runAfter: now });
    await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.Etsy, productId: "p2", externalListingId: "future", idempotencyKey: "future", payload: {}, runAfter: "2026-07-15T00:00:00.000Z" });
    expect(dup.id).toBe(first.id);
    expect(await database.select().from(schema.backgroundJobs)).toHaveLength(2);

    const workerOne = await claimJobs(database, "worker-1", 5, now);
    const workerTwo = await claimJobs(database, "worker-2", 5, now);
    expect(workerOne.map((j) => j.id)).toEqual([first.id]);
    expect(workerTwo).toHaveLength(0);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, first.id)))[0]).toMatchObject({ lockedBy: "worker-1", status: BackgroundJobStatus.Processing });

    await database.insert(schema.stockSyncAudit).values({ id: "audit-1", jobId: first.id, channel: PublishChannel.Ebay, productId: "p1", externalListingId: "ext", requestedMarketplaceStock: 1, resultStatus: StockSyncStatus.Updated, createdAt: now });
    await completeJob(database, first.id);
    expect((await database.select().from(schema.stockSyncAudit).where(eq(schema.stockSyncAudit.jobId, first.id)))).toHaveLength(1);

    const filtered = await listJobs(database, { status: BackgroundJobStatus.Succeeded, channel: PublishChannel.Ebay, page: 1, pageSize: 10 });
    expect(filtered).toHaveLength(1);

    await retryJob(database, first.id);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, first.id)))[0].status).toBe(BackgroundJobStatus.Pending);
    await cancelJob(database, first.id);
    expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, first.id)))[0].status).toBe(BackgroundJobStatus.Cancelled);
  });

  it("recovers stale locks and applies transient/permanent/max-attempt failure rules with sanitized errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    try {
      const database = db();
      const stale = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "stale", payload: {}, runAfter: new Date().toISOString() });
      await claimJobs(database, "worker", 1);
      await recoverStaleJobs(database, "2026-07-14T00:00:01.000Z");
      expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, stale.id)))[0].status).toBe(BackgroundJobStatus.RetryPending);

      await failJob(database, stale.id, { type: "Temporary", message: "Bearer secret-token failed", retryable: true });
      const retry = (await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, stale.id)))[0];
      expect(retry.status).toBe(BackgroundJobStatus.RetryPending);
      expect(retry.attemptCount).toBe(1);
      expect(retry.runAfter).toBe("2026-07-14T00:00:01.000Z");
      expect(retry.lastError).not.toContain("secret-token");

      const permanent = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "perm", payload: {}, runAfter: new Date().toISOString() });
      await failJob(database, permanent.id, { type: "Permanent", message: "bad", retryable: false });
      expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, permanent.id)))[0].status).toBe(BackgroundJobStatus.Failed);

      const maxed = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "max", payload: {}, maxAttempts: 1, runAfter: new Date().toISOString() });
      await failJob(database, maxed.id, { type: "Temporary", message: "again", retryable: true });
      expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, maxed.id)))[0].status).toBe(BackgroundJobStatus.DeadLetter);
    } finally { vi.useRealTimers(); }
  });
});
