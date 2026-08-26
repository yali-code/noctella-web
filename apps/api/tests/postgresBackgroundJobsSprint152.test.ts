import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BackgroundJobStatus, BackgroundJobType, PublishChannel } from "@noctella/shared";
import * as schema from "../src/db/schema.postgres";
import { applyPostgresMigrations, createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

if (postgresTestConfigured) {
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
}

let jobs: typeof import("../src/services/backgroundJobs");
beforeAll(async () => { if (postgresTestConfigured) jobs = await import("../src/services/backgroundJobs"); });
const suite = describe.skipIf(!postgresTestConfigured);
const migration = "0024_sprint152_background_jobs_runtime_parity.sql";

suite("Sprint 152 real PostgreSQL background jobs", () => {
  it("repairs an empty legacy stub, exposes the complete schema and indexes, and reapplies safely", async () => {
    const h = await createPostgresTestDb("0023_sprint151_orders_shipping_snapshot_parity.sql");
    try {
      const before = await h.pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='background_jobs' AND column_name='id'");
      expect(before.rows[0]?.data_type).toBe("timestamp with time zone");
      const client = await h.pool.connect();
      try { const applied = await applyPostgresMigrations(client, h.schemaName, migration); expect(applied.at(-1)).toBe(migration); } finally { client.release(); }
      const columns = await h.pool.query<{ column_name: string; data_type: string; is_nullable: "YES" | "NO"; column_default: string | null }>("SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='background_jobs' ORDER BY ordinal_position");
      expect(columns.rows.map(({ column_name, data_type, is_nullable }) => ({ column_name, data_type, is_nullable }))).toEqual([
        { column_name: "id", data_type: "text", is_nullable: "NO" },
        { column_name: "type", data_type: "text", is_nullable: "NO" },
        { column_name: "status", data_type: "text", is_nullable: "NO" },
        { column_name: "channel", data_type: "text", is_nullable: "YES" },
        { column_name: "product_id", data_type: "text", is_nullable: "YES" },
        { column_name: "external_listing_id", data_type: "text", is_nullable: "YES" },
        { column_name: "payload_snapshot", data_type: "jsonb", is_nullable: "NO" },
        { column_name: "idempotency_key", data_type: "text", is_nullable: "NO" },
        { column_name: "priority", data_type: "integer", is_nullable: "NO" },
        { column_name: "attempt_count", data_type: "integer", is_nullable: "NO" },
        { column_name: "max_attempts", data_type: "integer", is_nullable: "NO" },
        { column_name: "run_after", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "locked_at", data_type: "timestamp with time zone", is_nullable: "YES" },
        { column_name: "locked_by", data_type: "text", is_nullable: "YES" },
        { column_name: "last_error", data_type: "text", is_nullable: "YES" },
        { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "completed_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      ]);
      const defaults = Object.fromEntries(columns.rows.map((row) => [row.column_name, row.column_default]));
      expect(defaults.id).toBeNull();
      expect(defaults.priority).toMatch(/^0(?:::\w+)?$/);
      expect(defaults.attempt_count).toMatch(/^0(?:::\w+)?$/);
      expect(defaults.max_attempts).toMatch(/^5(?:::\w+)?$/);
      expect(defaults.created_at).toMatch(/^now\(\)$/i);
      expect(defaults.updated_at).toMatch(/^now\(\)$/i);

      const primaryKey = await h.pool.query<{ columns: string[] }>(`SELECT json_agg(a.attname::text ORDER BY key.ordinality) AS columns
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
        WHERE n.nspname = current_schema() AND t.relname = 'background_jobs' AND c.contype = 'p'
        GROUP BY c.oid`);
      expect(primaryKey.rows).toEqual([{ columns: ["id"] }]);

      const indexes = await h.pool.query<{ index_name: string; is_unique: boolean; columns: string[] }>(`SELECT i.relname AS index_name, ix.indisunique AS is_unique, json_agg(a.attname::text ORDER BY key.ordinality) AS columns
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_index ix ON ix.indrelid = t.oid
        JOIN pg_class i ON i.oid = ix.indexrelid
        CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
        WHERE n.nspname = current_schema() AND t.relname = 'background_jobs'
        GROUP BY i.relname, ix.indisunique`);
      const indexByName = Object.fromEntries(indexes.rows.map((row) => [row.index_name, row]));
      expect(indexByName.idx_background_jobs_idempotency).toEqual({ index_name: "idx_background_jobs_idempotency", is_unique: true, columns: ["idempotency_key"] });
      expect(indexByName.idx_background_jobs_status_run?.columns).toEqual(["status", "run_after", "priority"]);
      expect(indexByName.idx_background_jobs_type?.columns).toEqual(["type"]);
      expect(indexByName.idx_background_jobs_channel?.columns).toEqual(["channel"]);
      expect(indexByName.idx_background_jobs_product?.columns).toEqual(["product_id"]);
      expect(indexByName.idx_background_jobs_external_listing?.columns).toEqual(["external_listing_id"]);
      const again = await h.pool.connect();
      try { expect((await applyPostgresMigrations(again, h.schemaName, migration)).at(-1)).toBe(migration); } finally { again.release(); }
    } finally { await h.close(); }
  });

  it("fails closed without changing a non-empty irrecoverable Sprint 24 stub", async () => {
    const h = await createPostgresTestDb("0023_sprint151_orders_shipping_snapshot_parity.sql");
    try {
      await h.pool.query("INSERT INTO background_jobs DEFAULT VALUES");
      const client = await h.pool.connect();
      let failure: unknown;
      try { await applyPostgresMigrations(client, h.schemaName, migration); } catch (error) { failure = error; } finally { client.release(); }
      expect(failure).toBeInstanceOf(Error);
      const wrapped = failure as Error & { cause?: { message?: string; code?: string } };
      expect(wrapped.message).toBe(`POSTGRES_MIGRATION_FAILED:${migration}`);
      expect(wrapped.cause?.message).toMatch(/BACKGROUND_JOBS_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION/);
      expect(wrapped.cause?.code).toBe("P0001");
      expect((await h.pool.query("SELECT count(*)::int AS count FROM background_jobs")).rows[0].count).toBe(1);
      const columns = await h.pool.query<{ column_name: string; data_type: string; column_default: string | null }>("SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='background_jobs' ORDER BY ordinal_position");
      expect(columns.rows.map((row) => row.column_name)).toEqual(["id"]);
      expect(columns.rows[0]?.data_type).toBe("timestamp with time zone");
      expect(columns.rows[0]?.column_default).toMatch(/^now\(\)$/i);
    } finally { await h.close(); }
  });

  it("enqueues native JSON/timestamps idempotently and rethrows unrelated insert failures", async () => {
    const h = await createPostgresTestDb(migration);
    try {
      const runAfter = "2026-08-26T10:00:00.000Z";
      const first = await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, channel: PublishChannel.Ebay, productId: "p1", payload: { nested: { ok: true }, values: [1, null, "1"] }, idempotencyKey: "idem", runAfter });
      const duplicate = await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: { changed: true }, idempotencyKey: "idem", runAfter });
      expect(duplicate.id).toBe(first.id);
      expect(duplicate.payloadSnapshot).toBe(JSON.stringify({ nested: { ok: true }, values: [1, null, "1"] }));
      expect(duplicate.runAfter).toBe(runAfter);
      expect((await h.db.select().from(schema.backgroundJobs))).toHaveLength(1);
      const raw = (await h.pool.query("SELECT id,payload_snapshot,run_after FROM background_jobs")).rows[0];
      expect(typeof raw.id).toBe("string"); expect(raw.payload_snapshot).toEqual({ nested: { ok: true }, values: [1, null, "1"] }); expect(raw.run_after).toBeInstanceOf(Date);
      await h.pool.query("ALTER TABLE background_jobs DROP COLUMN type");
      await expect(jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "not-a-duplicate" })).rejects.toThrow();
    } finally { await h.close(); }
  });

  it("claims due jobs once across concurrent workers and completes with normalized timestamps", async () => {
    const h = await createPostgresTestDb(migration);
    try {
      await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "due", runAfter: "2026-08-26T09:00:00.000Z" });
      await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "future", runAfter: "2026-08-27T09:00:00.000Z" });
      const [one, two] = await Promise.all([jobs.claimJobs(h.db as any, "worker-1", 1, "2026-08-26T10:00:00.000Z"), jobs.claimJobs(h.db as any, "worker-2", 1, "2026-08-26T10:00:00.000Z")]);
      expect([...one, ...two]).toHaveLength(1);
      const claimed = [...one, ...two][0];
      expect(claimed).toMatchObject({ status: BackgroundJobStatus.Processing }); expect(claimed.lockedAt).toMatch(/Z$/); expect(["worker-1","worker-2"]).toContain(claimed.lockedBy);
      await jobs.completeJob(h.db as any, claimed.id);
      const [completed] = await jobs.listJobs(h.db as any, { status: BackgroundJobStatus.Succeeded });
      expect(completed).toMatchObject({ status: BackgroundJobStatus.Succeeded, lockedAt: null, lockedBy: null }); expect(completed.completedAt).toMatch(/Z$/);
      expect((await h.db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.idempotencyKey, "future")))[0].status).toBe(BackgroundJobStatus.Pending);
    } finally { await h.close(); }
  });

  it("persists retry/dead-letter state and recovers only stale locks", async () => {
    const h = await createPostgresTestDb(migration);
    try {
      const retry = await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "retry", maxAttempts: 2 });
      await jobs.failJob(h.db as any, retry.id, { type: "Temporary", message: "safe failure", retryable: true });
      let [row] = await jobs.listJobs(h.db as any, { status: BackgroundJobStatus.RetryPending });
      expect(row).toMatchObject({ attemptCount: 1, lastError: "Temporary: safe failure", lockedAt: null, lockedBy: null }); expect(row.runAfter).toMatch(/Z$/);
      await jobs.failJob(h.db as any, retry.id, { type: "Temporary", message: "safe failure", retryable: true });
      [row] = await jobs.listJobs(h.db as any, { status: BackgroundJobStatus.DeadLetter });
      expect(row.attemptCount).toBe(2); expect(row.completedAt).toMatch(/Z$/);

      const stale = await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "stale" });
      const fresh = await jobs.enqueueJob(h.db as any, { type: BackgroundJobType.StockSyncListing, payload: {}, idempotencyKey: "fresh" });
      await h.db.update(schema.backgroundJobs).set({ status: BackgroundJobStatus.Processing, lockedAt: new Date("2026-08-26T08:00:00.000Z"), lockedBy: "old" }).where(eq(schema.backgroundJobs.id, stale.id));
      await h.db.update(schema.backgroundJobs).set({ status: BackgroundJobStatus.Processing, lockedAt: new Date("2026-08-26T10:00:00.000Z"), lockedBy: "new" }).where(eq(schema.backgroundJobs.id, fresh.id));
      await jobs.recoverStaleJobs(h.db as any, "2026-08-26T09:00:00.000Z");
      const states = await h.db.select().from(schema.backgroundJobs);
      expect(states.find((item) => item.id === stale.id)?.status).toBe(BackgroundJobStatus.RetryPending);
      expect(states.find((item) => item.id === fresh.id)?.status).toBe(BackgroundJobStatus.Processing);
    } finally { await h.close(); }
  });
});
