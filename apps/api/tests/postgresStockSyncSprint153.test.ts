import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.postgres";
import { encryptCredential } from "../src/services/credentialEncryption";
import { applyPostgresMigrations, createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

if (postgresTestConfigured) {
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}

const describePostgres = postgresTestConfigured ? describe : describe.skip;
let stockSync: typeof import("../src/services/stockSync");
let backgroundJobs: typeof import("../src/services/backgroundJobs");
let harness: PostgresTestDb | undefined;

describePostgres("Sprint 153 PostgreSQL stock-sync runtime parity", () => {
  beforeAll(async () => {
    stockSync = await import("../src/services/stockSync");
    backgroundJobs = await import("../src/services/backgroundJobs");
  });
  afterEach(async () => { await harness?.close(); harness = undefined; });

  it("applies the complete migration chain through 0025 twice with the stock-sync target shape", async () => {
    harness = await createPostgresTestDb("0025_sprint153_stock_sync_runtime_parity.sql");
    const retained = await stockSync.createStockSyncConflict(harness.db as any, { channel: "ebay", conflictType: "manual_review", details: { retained: true } });
    expect((await harness.migrateAgain()).at(-1)).toBe("0025_sprint153_stock_sync_runtime_parity.sql");
    expect(await harness.db.select().from(schema.stockSyncConflicts)).toEqual([expect.objectContaining({ id: retained.id, channel: "ebay", conflictType: "manual_review", detailsSnapshot: { retained: true } })]);
    const result = await harness.pool.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name IN ('marketplace_inventory_snapshots', 'stock_sync_conflicts', 'stock_sync_audit')
      ORDER BY table_name, ordinal_position
    `, [harness.schemaName]);
    expect(result.rows).toEqual(expect.arrayContaining([
      { table_name: "marketplace_inventory_snapshots", column_name: "captured_at", data_type: "timestamp with time zone" },
      { table_name: "stock_sync_conflicts", column_name: "details_snapshot", data_type: "jsonb" },
      { table_name: "stock_sync_audit", column_name: "created_at", data_type: "timestamp with time zone" },
    ]));
  });

  it("makes Product EUR price nullable through 0026 without changing an existing price", async () => {
    harness = await createPostgresTestDb("0025_sprint153_stock_sync_runtime_parity.sql");
    const now = new Date();
    await harness.db.insert(schema.products).values({ id: "p-priced", sku: "SPRINT153-PRICED", title: "Priced", slug: "sprint153-priced", type: "unique", status: "draft", stockQuantity: 1, priceEur: "123.450000", createdAt: now, updatedAt: now });

    const migrate = async () => {
      const client = await harness!.pool.connect();
      try { return await applyPostgresMigrations(client, harness!.schemaName); } finally { client.release(); }
    };
    expect((await migrate()).at(-1)).toBe("0026_sprint153_product_price_eur_nullable_parity.sql");
    const nullable = await harness.pool.query<{ is_nullable: "YES" | "NO" }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'products' AND column_name = 'price_eur'",
      [harness.schemaName],
    );
    expect(nullable.rows).toEqual([{ is_nullable: "YES" }]);
    expect((await harness.pool.query<{ price_eur: string }>("SELECT price_eur FROM products WHERE id = 'p-priced'")).rows).toEqual([{ price_eur: "123.450000" }]);

    await harness.db.insert(schema.products).values({ id: "p-unpriced", sku: "SPRINT153-UNPRICED", title: "Unpriced", slug: "sprint153-unpriced", type: "unique", status: "draft", stockQuantity: 1, createdAt: now, updatedAt: now });
    expect((await harness.pool.query<{ price_is_null: boolean }>("SELECT price_eur IS NULL AS price_is_null FROM products WHERE id = 'p-unpriced'")).rows).toEqual([{ price_is_null: true }]);
    expect((await migrate()).at(-1)).toBe("0026_sprint153_product_price_eur_nullable_parity.sql");
  });

  it("executes a due stock-sync listing job and durably records a normalized conflict", async () => {
    harness = await createPostgresTestDb();
    const now = new Date();
    await harness.db.insert(schema.externalListings).values({ id: "listing-missing-product", productId: "missing-product", channel: "ebay", connectionId: "missing-connection", externalListingId: "external-1", externalStatus: "active", payloadSnapshot: {}, publishedAt: now, updatedAt: now });
    const job = await backgroundJobs.enqueueJob(harness.db as any, { type: "stock_sync_listing", channel: "ebay", productId: "missing-product", externalListingId: "listing-missing-product", payload: { externalListingId: "listing-missing-product" }, idempotencyKey: "sprint153:stock-sync" });
    expect(await backgroundJobs.runDueJobs(harness.db as any, "sprint153-worker", 1)).toBe(1);
    const [persistedJob] = await harness.db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id));
    const [conflict] = await harness.db.select().from(schema.stockSyncConflicts);
    expect(persistedJob.status).toBe("succeeded");
    expect(conflict).toMatchObject({ channel: "ebay", productId: "missing-product", externalListingId: "external-1", conflictType: "product_missing", status: "open" });
    expect(conflict.detectedAt).toBeInstanceOf(Date);
  });

  it("persists snapshot, auto-resolved conflict, and audit through actual background dispatch", async () => {
    harness = await createPostgresTestDb();
    const now = new Date();
    await harness.db.insert(schema.products).values({ id: "p-stock", sku: "SPRINT153", title: "Stock sync", slug: "sprint153", type: "unique", status: "active", stockQuantity: 3, createdAt: now, updatedAt: now });
    await harness.db.insert(schema.marketplaceConnections).values({ id: "conn-stock", channel: "ebay", accountLabel: "Sprint 153", encryptedAccessToken: encryptCredential("token"), status: "connected", createdAt: now, updatedAt: now });
    await harness.db.insert(schema.externalListings).values({ id: "listing-stock", productId: "p-stock", channel: "ebay", connectionId: "conn-stock", externalListingId: "external-stock", externalStatus: "active", payloadSnapshot: {}, publishedAt: now, updatedAt: now });
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ stock: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ stock: 3 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await backgroundJobs.enqueueJob(harness.db as any, { type: "stock_sync_listing", channel: "ebay", productId: "p-stock", externalListingId: "listing-stock", payload: { externalListingId: "listing-stock" }, idempotencyKey: "sprint153:stock-success" });
    expect(await backgroundJobs.runDueJobs(harness.db as any, "sprint153-worker", 1)).toBe(1);
    const [snapshot] = await harness.db.select().from(schema.marketplaceInventorySnapshots);
    const [conflict] = await harness.db.select().from(schema.stockSyncConflicts);
    const [audit] = await harness.db.select().from(schema.stockSyncAudit);
    expect(snapshot).toMatchObject({ localStock: 3, marketplaceStock: 1 });
    expect(snapshot.capturedAt).toBeInstanceOf(Date);
    expect(conflict).toMatchObject({ status: "auto_resolved", localStock: 3, marketplaceStock: 1 });
    expect(audit).toMatchObject({ requestedMarketplaceStock: 3, confirmedMarketplaceStock: 3, resultStatus: "updated" });
    expect(audit.createdAt).toBeInstanceOf(Date);
  });

  it("fails closed and rolls back when a historical incomplete stub contains rows", async () => {
    const connectionString = process.env.POSTGRES_TEST_DATABASE_URL!;
    const schemaName = `sprint153_legacy_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString, max: 1, options: `-c search_path=${schemaName}` });
    const admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    try {
      await pool.query("CREATE TABLE marketplace_inventory_snapshots (id timestamptz PRIMARY KEY NOT NULL DEFAULT now()); CREATE TABLE stock_sync_conflicts (id timestamptz PRIMARY KEY NOT NULL DEFAULT now()); CREATE TABLE stock_sync_audit (id timestamptz PRIMARY KEY NOT NULL DEFAULT now()); INSERT INTO stock_sync_conflicts DEFAULT VALUES");
      const client = await pool.connect();
      try { await expect(applyPostgresMigrations(client, schemaName)).rejects.toMatchObject({ message: "POSTGRES_MIGRATION_FAILED:0025_sprint153_stock_sync_runtime_parity.sql", code: "P0001", cause: expect.objectContaining({ message: expect.stringContaining("STOCK_SYNC_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION:stock_sync_conflicts") }) }); } finally { client.release(); }
      expect((await pool.query("SELECT count(*)::int AS count FROM stock_sync_conflicts")).rows[0].count).toBe(1);
      const columns = await pool.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'stock_sync_conflicts' ORDER BY ordinal_position", [schemaName]);
      expect(columns.rows).toEqual([{ column_name: "id", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" }]);
      expect(columns.rows.some((row) => row.column_name === "channel" || row.column_name === "conflict_type")).toBe(false);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("rejects a populated same-count malformed table with the deterministic reconciliation marker", async () => {
    const connectionString = process.env.POSTGRES_TEST_DATABASE_URL!;
    const schemaName = `sprint153_malformed_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString, max: 1, options: `-c search_path=${schemaName}` });
    const admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    try {
      await pool.query(`
        CREATE TABLE marketplace_inventory_snapshots (id timestamptz PRIMARY KEY NOT NULL DEFAULT now());
        CREATE TABLE stock_sync_audit (id timestamptz PRIMARY KEY NOT NULL DEFAULT now());
        CREATE TABLE stock_sync_conflicts (
          id text PRIMARY KEY, channel text NOT NULL, product_id text, external_listing_id text,
          conflict_type text NOT NULL, status text NOT NULL, local_stock integer, marketplace_stock integer,
          details_snapshot jsonb, unexpected_column text, detected_at timestamptz NOT NULL,
          resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO stock_sync_conflicts (id, channel, conflict_type, status, detected_at) VALUES ('legacy', 'ebay', 'manual_review', 'open', now());
      `);
      const client = await pool.connect();
      try { await expect(applyPostgresMigrations(client, schemaName)).rejects.toMatchObject({ message: "POSTGRES_MIGRATION_FAILED:0025_sprint153_stock_sync_runtime_parity.sql", code: "P0001", cause: expect.objectContaining({ message: expect.stringContaining("STOCK_SYNC_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION:stock_sync_conflicts") }) }); } finally { client.release(); }
      expect((await pool.query("SELECT count(*)::int AS count FROM stock_sync_conflicts")).rows[0].count).toBe(1);
      const names = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'stock_sync_conflicts' ORDER BY ordinal_position", [schemaName])).rows.map((row) => row.column_name);
      expect(names).toContain("unexpected_column");
      expect(names).not.toContain("resolution");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("rejects an otherwise valid populated final shape without the required id primary key", async () => {
    const connectionString = process.env.POSTGRES_TEST_DATABASE_URL!;
    const schemaName = `sprint153_missing_pk_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString, max: 1, options: `-c search_path=${schemaName}` });
    const admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const expectedColumns = ["id", "channel", "product_id", "external_listing_id", "conflict_type", "status", "local_stock", "marketplace_stock", "details_snapshot", "resolution", "detected_at", "resolved_at", "created_at", "updated_at"];
    try {
      await pool.query(`
        CREATE TABLE marketplace_inventory_snapshots (id timestamptz PRIMARY KEY NOT NULL DEFAULT now());
        CREATE TABLE stock_sync_audit (id timestamptz PRIMARY KEY NOT NULL DEFAULT now());
        CREATE TABLE stock_sync_conflicts (
          id text NOT NULL, channel text NOT NULL, product_id text, external_listing_id text,
          conflict_type text NOT NULL, status text NOT NULL, local_stock integer, marketplace_stock integer,
          details_snapshot jsonb, resolution text, detected_at timestamptz NOT NULL, resolved_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO stock_sync_conflicts (id, channel, conflict_type, status, detected_at) VALUES ('legacy-no-pk', 'ebay', 'manual_review', 'open', now());
      `);
      const client = await pool.connect();
      try { await expect(applyPostgresMigrations(client, schemaName)).rejects.toMatchObject({ message: "POSTGRES_MIGRATION_FAILED:0025_sprint153_stock_sync_runtime_parity.sql", code: "P0001", cause: expect.objectContaining({ message: expect.stringContaining("STOCK_SYNC_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION:stock_sync_conflicts") }) }); } finally { client.release(); }
      expect((await pool.query("SELECT id FROM stock_sync_conflicts")).rows).toEqual([{ id: "legacy-no-pk" }]);
      const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'stock_sync_conflicts' ORDER BY ordinal_position", [schemaName])).rows.map((row) => row.column_name);
      expect(columns).toEqual(expectedColumns);
      expect((await pool.query("SELECT count(*)::int AS count FROM pg_catalog.pg_constraint AS con JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace WHERE ns.nspname = $1 AND rel.relname = 'stock_sync_conflicts' AND con.contype = 'p'", [schemaName])).rows[0].count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = 'stock_sync_conflicts'", [schemaName])).rows[0].count).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("round-trips conflict JSON and timestamps through the public service contract", async () => {
    harness = await createPostgresTestDb();
    const created = await stockSync.createStockSyncConflict(harness.db as any, { channel: "etsy", productId: "p-1", conflictType: "manual_review", details: { reason: "fixture" } });
    const resolved = await stockSync.resolveStockSyncConflict(harness.db as any, created.id, "MarkResolved");
    expect(resolved.detailsSnapshot).toBe('{"reason":"fixture"}');
    expect(typeof resolved.detectedAt).toBe("string");
    expect(typeof resolved.resolvedAt).toBe("string");
  });
});
