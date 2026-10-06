import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { BackgroundJobStatus, BackgroundJobType, PublishChannel, StockSyncStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { cancelJob, claimJobs, completeJob, enqueueJob, executeJob, failJob, listJobs, recoverStaleJobs, retryJob } from "../src/services/backgroundJobs";

type TestDb = ReturnType<typeof db>;
function db() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }

function tableInfo(sqlite: Database.Database, table: string) { return sqlite.prepare(`PRAGMA table_info(${table})`).all(); }
function indexNames(sqlite: Database.Database, table: string) { return sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>; }

describe("claim fencing", () => {
  const time = "2030-01-01T00:00:00.000Z";
  const error = { type: "Temporary", message: "failure", retryable: true };
  const read = async (database: TestDb) => (await database.select().from(schema.backgroundJobs))[0];
  async function claimed() {
    const database = db();
    await enqueueJob(database, { type: "unsupported-test-handler", idempotencyKey: "claim", runAfter: time });
    const [a, b] = await Promise.all([claimJobs(database, "same-worker", 1, time), claimJobs(database, "same-worker", 1, time)]);
    expect([...a, ...b]).toHaveLength(1);
    const job = [...a, ...b][0];
    expect(job.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    return { database, job };
  }
  it("only the current token completes once", async () => {
    const { database, job } = await claimed();
    const before = await read(database);
    for (const token of [undefined, null, "", "wrong"]) {
      expect(await completeJob(database, job.id, token as any)).toBe(false);
      expect(await read(database)).toEqual(before);
    }
    expect(await completeJob(database, job.id, job.claimToken)).toBe(true);
    const completed = await read(database);
    expect(completed).toMatchObject({ status: "succeeded", claimToken: null, lockedAt: null, lockedBy: null });
    expect(await completeJob(database, job.id, job.claimToken)).toBe(false);
    expect(await failJob(database, job.id, error, job.claimToken)).toBe(false);
    expect(await read(database)).toEqual(completed);
  });
  it("only the current token fails once; rejected failures leave every field unchanged", async () => {
    const { database, job } = await claimed();
    const before = await read(database);
    for (const token of [undefined, null, "", "wrong"]) {
      expect(await failJob(database, job.id, error, token as any)).toBe(false);
      expect(await read(database)).toEqual(before);
    }
    expect(await failJob(database, job.id, error, job.claimToken)).toBe(true);
    const failed = await read(database);
    expect(failed).toMatchObject({ status: "retry_pending", attemptCount: 1, claimToken: null, lockedAt: null, lockedBy: null });
    expect(await failJob(database, job.id, error, job.claimToken)).toBe(false);
    expect(await read(database)).toEqual(failed);
  });
  it.each(["recovery", "retry", "cancel"])("%s invalidates ownership and protects the replacement claim", async (action) => {
    const { database, job } = await claimed();
    if (action === "recovery") await recoverStaleJobs(database, time);
    if (action === "retry") await retryJob(database, job.id);
    if (action === "cancel") await cancelJob(database, job.id);
    const invalidated = await read(database);
    expect(invalidated.claimToken).toBeNull();
    expect(await completeJob(database, job.id, job.claimToken)).toBe(false);
    expect(await failJob(database, job.id, error, job.claimToken)).toBe(false);
    expect(await executeJob(database, job)).toBe(false); // An owned unsupported handler would throw.
    expect(await read(database)).toEqual(invalidated);
    if (action === "cancel") await retryJob(database, job.id);
    const [replacement] = await claimJobs(database, "same-worker", 1, time);
    expect(replacement.claimToken).not.toBe(job.claimToken);
    const before = await read(database);
    expect(await completeJob(database, job.id, job.claimToken)).toBe(false);
    expect(await failJob(database, job.id, error, job.claimToken)).toBe(false);
    expect(await executeJob(database, job)).toBe(false);
    expect(await read(database)).toEqual(before);
    expect(await completeJob(database, job.id, replacement.claimToken)).toBe(true);
  });
  it("fences the final failure write when recovery occurs after its read", async () => {
    const { database, job } = await claimed();
    let replacement: any;
    // Interpose after the real guarded SELECT, before failJob's final UPDATE.
    const proxy = Object.create(database);
    proxy.select = (...args: any[]) => {
      const query = (database.select as any)(...args);
      return { from: (table: any) => {
        const from = query.from(table);
        return { where: async (condition: any) => {
          const selected = await from.where(condition);
          await recoverStaleJobs(database, time);
          [replacement] = await claimJobs(database, "same-worker", 1, time);
          return selected;
        } };
      } };
    };
    expect(await failJob(proxy, job.id, error, job.claimToken)).toBe(false);
    expect(await read(database)).toEqual(replacement);
    expect(await completeJob(database, job.id, replacement.claimToken)).toBe(true);
  });
  it("admits only a supplied current claim and does not adopt the stored token", async () => {
    const { database, job } = await claimed();
    const before = await read(database);
    expect(await executeJob(database, { ...job, claimToken: null })).toBe(false);
    expect(await executeJob(database, { ...job, claimToken: "wrong" })).toBe(false);
    expect(await read(database)).toEqual(before);
    await expect(executeJob(database, job)).rejects.toMatchObject({ message: "Unsupported job type" });
    await database.update(schema.backgroundJobs).set({ type: BackgroundJobType.RefreshMarketplaceReturn }).where(eq(schema.backgroundJobs.id, job.id));
    expect(await executeJob(database, { ...job, type: BackgroundJobType.RefreshMarketplaceReturn })).toBe(true);
    expect((await read(database)).claimToken).toBeNull();
  });
  it("additive initialization preserves historical rows and never invents processing ownership", async () => {
    const database = db();
    const client = (database as any).$client as Database.Database;
    client.exec("ALTER TABLE background_jobs DROP COLUMN claim_token");
    for (const status of ["pending", "retry_pending", "processing", "succeeded", "failed", "cancelled", "dead_letter"]) {
      client.prepare("INSERT INTO background_jobs(id,type,status,payload_snapshot,idempotency_key,run_after) VALUES (?, 'test', ?, '{}', ?, ?)").run(status, status, status, time);
    }
    const before = client.prepare("SELECT * FROM background_jobs ORDER BY id").all() as any[];
    ensureSchema(client); ensureSchema(client);
    expect(client.prepare("SELECT * FROM background_jobs ORDER BY id").all()).toEqual(before.map(row => ({ ...row, claim_token: null })));
    expect(tableInfo(client, "background_jobs")).toContainEqual(expect.objectContaining({ name: "claim_token", notnull: 0, dflt_value: null }));
    const historical = (await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, "processing")))[0];
    expect(await completeJob(database, historical.id, historical.claimToken as any)).toBe(false);
    expect(await failJob(database, historical.id, error, historical.claimToken as any)).toBe(false);
    expect(await executeJob(database, historical)).toBe(false);
    expect(client.prepare("SELECT * FROM background_jobs ORDER BY id").all()).toEqual(before.map(row => ({ ...row, claim_token: null })));
  });
});

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
    await completeJob(database, first.id, workerOne[0].claimToken);
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

      const [reclaimed] = await claimJobs(database, "worker", 1);
      await failJob(database, stale.id, { type: "Temporary", message: "Bearer secret-token failed", retryable: true }, reclaimed.claimToken);
      const retry = (await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, stale.id)))[0];
      expect(retry.status).toBe(BackgroundJobStatus.RetryPending);
      expect(retry.attemptCount).toBe(1);
      expect(retry.runAfter).toBe("2026-07-14T00:00:01.000Z");
      expect(retry.lastError).not.toContain("secret-token");

      const permanent = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "perm", payload: {}, runAfter: new Date().toISOString() });
      const [permanentClaim] = await claimJobs(database, "worker", 1);
      await failJob(database, permanent.id, { type: "Permanent", message: "bad", retryable: false }, permanentClaim.claimToken);
      expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, permanent.id)))[0].status).toBe(BackgroundJobStatus.Failed);

      const maxed = await enqueueJob(database, { type: BackgroundJobType.StockSyncListing, idempotencyKey: "max", payload: {}, maxAttempts: 1, runAfter: new Date().toISOString() });
      const [maxClaim] = await claimJobs(database, "worker", 1);
      await failJob(database, maxed.id, { type: "Temporary", message: "again", retryable: true }, maxClaim.claimToken);
      expect((await database.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, maxed.id)))[0].status).toBe(BackgroundJobStatus.DeadLetter);
    } finally { vi.useRealTimers(); }
  });
});
