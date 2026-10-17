/**
 * #424 FAZ B preparation: disposable-PostgreSQL compatibility of the actual Etsy 0039 migration (Draft #370/#371)
 * with the photo stack's actual 0040/0041 (and the dependency-safe ownership rollback). Each case uses a fresh,
 * isolated schema created by the existing harness at 0038 (main's latest), seeded with application data first.
 *
 * `fixtures/etsy/0039_etsy_listing_form_parity.sql` is a byte-identical copy of the Etsy PRs' file (git blob
 * 0a69ab92fe7d51a9e736afd0e15cea87fb232677), vendored ONLY as a test input: it is not in postgres-migrations,
 * so no application path or harness applies it. If the Etsy PR changes 0039, the provenance test fails and the
 * fixture must be refreshed from that PR.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

vi.setConfig({ testTimeout: 180_000 });
const read = (file: string) => readFileSync(file, "utf8");
const MIGRATIONS = path.resolve(__dirname, "../src/db/postgres-migrations");
const ETSY_0039_PATH = path.resolve(__dirname, "fixtures/etsy/0039_etsy_listing_form_parity.sql");
const ETSY_0039_BLOB = "0a69ab92fe7d51a9e736afd0e15cea87fb232677";
const ETSY_0039 = read(ETSY_0039_PATH);
const PHOTO_0040 = read(path.join(MIGRATIONS, "0040_photo_operation_ownership.sql"));
const PHOTO_0041 = read(path.join(MIGRATIONS, "0041_photo_w2_upload_intents.sql"));
const OWNERSHIP_DOWN = read(path.resolve(__dirname, "../../../docs/engineering/proposed-photo-ownership/down.sql"));
const OWNERSHIP_TABLES = ["photo_w2_upload_intents", "photo_operation_artifacts", "photo_operation_generations", "photo_operations", "photo_storage_roots"];
const BASELINE = "0038_background_job_claim_fencing.sql";

it("the vendored 0039 is byte-identical to the Etsy PRs' migration (git blob pin)", () => {
  const body = Buffer.from(ETSY_0039.replace(/\r\n/g, "\n"), "utf8"); // git stores LF; Windows checkouts may not
  const blob = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  expect(blob).toBe(ETSY_0039_BLOB);
});

it("0039 only adds nullable products columns; 0040/0041 never touch products (static)", () => {
  const statements = ETSY_0039.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
  expect(statements.length).toBeGreaterThan(0);
  for (const s of statements) expect(s).toMatch(/^ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_[a-z0-9_]+ [a-z]+;$/);
  const executable = (ddl: string) => ddl.split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/--.*$/, "")).join("\n");
  for (const ddl of [PHOTO_0040, PHOTO_0041]) expect(executable(ddl)).not.toMatch(/ALTER TABLE\s+products|\bDROP\s|etsy_/i);
});

it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL compatibility acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

async function inTransaction(h: PostgresTestDb, sqlText: string) {
  const client: pg.PoolClient = await h.pool.connect();
  try { await client.query("BEGIN"); await client.query(sqlText); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function fresh(): Promise<PostgresTestDb> {
  const h = await createPostgresTestDb(BASELINE);
  await h.pool.query("INSERT INTO categories (id, name, slug) VALUES ('cat-1', 'Category', 'category-1')");
  await h.pool.query("INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES ('prod-1', 'SKU-1', 'Existing product', 'existing-1', 'unique_item', 'draft', 'cat-1')");
  await h.pool.query(`INSERT INTO product_photos (id, product_id, url, thumbnail_url, filename, mime_type, size_bytes, width, height)
    VALUES ('photo-1', 'prod-1', '/images/product-photos/a.webp', '/images/product-photos/a-thumb.webp', 'a.webp', 'image/webp', 10, 4, 3)`);
  return h;
}
const appData = async (h: PostgresTestDb) => ({
  product: (await h.pool.query("SELECT id, sku, title, slug, type, status, category_id FROM products ORDER BY id")).rows,
  photos: (await h.pool.query("SELECT id, product_id, url, thumbnail_url, filename, size_bytes FROM product_photos ORDER BY id")).rows,
});
const tableExists = async (h: PostgresTestDb, table: string) =>
  (await h.pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2", [h.schemaName, table])).rowCount === 1;
/** Order-insensitive catalog of the affected objects: columns and constraint definitions. */
async function catalog(h: PostgresTestDb) {
  const tables = ["products", "product_photos", ...OWNERSHIP_TABLES];
  const columns = (await h.pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, column_name`, [h.schemaName, tables])).rows;
  const constraints = (await h.pool.query(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = $1::regnamespace ORDER BY rel, conname`, [h.schemaName])).rows
    .map((r: any) => ({ ...r, rel: String(r.rel).replace(`${h.schemaName}.`, "").replace(/"/g, "") }));
  return { columns, constraints };
}
async function withFresh(work: (h: PostgresTestDb) => Promise<void>) {
  const h = await fresh();
  try { await work(h); } finally { await h.close(); }
}

describe.skipIf(!postgresTestConfigured)("disposable PostgreSQL: Etsy 0039 with photo 0040/0041", () => {
  it("forward Etsy-first order (0039 → 0040 → 0041) preserves application data and yields the full schema", () => withFresh(async (h) => {
    const before = await appData(h);
    for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    expect(await appData(h)).toEqual(before);
    const etsy = (await h.pool.query("SELECT etsy_taxonomy_id, etsy_quantity, etsy_is_supply FROM products WHERE id = 'prod-1'")).rows[0];
    expect(etsy).toEqual({ etsy_taxonomy_id: null, etsy_quantity: null, etsy_is_supply: null }); // nullable, no backfill
    for (const t of OWNERSHIP_TABLES) expect(await tableExists(h, t)).toBe(true);
    const fk = (await catalog(h)).constraints.find((c: any) => c.rel === "photo_w2_upload_intents" && /FOREIGN KEY \(operation_id\)/.test(c.def));
    expect(fk?.def).toMatch(/REFERENCES photo_operations\(id\)/);
  }));

  it("photo-first order (0040 → 0041 → 0039, the current stack) yields the identical catalog and data", async () => {
    let etsyFirst: Awaited<ReturnType<typeof catalog>> | undefined, photoFirst: typeof etsyFirst;
    await withFresh(async (h) => { for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl); etsyFirst = await catalog(h); });
    await withFresh(async (h) => {
      const before = await appData(h);
      for (const ddl of [PHOTO_0040, PHOTO_0041, ETSY_0039]) await inTransaction(h, ddl);
      expect(await appData(h)).toEqual(before);
      photoFirst = await catalog(h);
    });
    expect(photoFirst).toEqual(etsyFirst);
    // 0038 already has legacy etsy_ columns: assert the 23 columns declared by 0039, not the overall etsy_ count.
    const introduced = [...ETSY_0039.matchAll(/ALTER TABLE products ADD COLUMN IF NOT EXISTS (etsy_[a-z0-9_]+)/g)].map((m) => m[1]);
    expect(introduced.length).toBe(23);
    expect(new Set(introduced).size).toBe(23);
    const productColumns = etsyFirst!.columns.filter((c: any) => c.table_name === "products");
    for (const name of introduced)
      expect(productColumns.find((c: any) => c.column_name === name)?.is_nullable).toBe("YES");
  });

  it("re-applying 0039, 0040 and 0041 is idempotent: no error, catalog and data unchanged", () => withFresh(async (h) => {
    for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    const [schema, data] = [await catalog(h), await appData(h)];
    for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    expect(await catalog(h)).toEqual(schema);
    expect(await appData(h)).toEqual(data);
  }));

  it("with 0039 present, dropping photo_operations before the 0041 intents is refused by PostgreSQL (dependency), atomically", () => withFresh(async (h) => {
    for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    // Even with no rows: the 0041 foreign key is a dependent object (SQLSTATE 2BP01). This is the D1 root cause on
    // real PostgreSQL, previously only inferred.
    await expect(inTransaction(h, "DROP TABLE photo_operations")).rejects.toMatchObject({ code: "2BP01" });
    for (const t of OWNERSHIP_TABLES) expect(await tableExists(h, t)).toBe(true);
  }));

  it("the dependency-safe rollback with 0039 present drops only ownership objects, keeps Etsy columns and data, and re-applies cleanly", () => withFresh(async (h) => {
    for (const ddl of [ETSY_0039, PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    await h.pool.query("UPDATE products SET etsy_taxonomy_id = 'tax-77', etsy_quantity = 3 WHERE id = 'prod-1'");
    const bind = async (op: string, token: string) => {
      await h.pool.query(`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
        VALUES ($1, 'product_upload', 'w2_request', $2, $3, $4, $5, $6, 1, 'o', $7, 'committed', 0, 0, 0)`, [op, token, `${op}-photo`, `${op}.webp`, `${op}-thumb.webp`, "a".repeat(64), `${op}-nonce`]);
      await h.pool.query("INSERT INTO photo_w2_upload_intents (token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id, created_ms) VALUES ($1, 'noctella', 'a', 'prod-1', $2, '', $3, 0)", [token, "a".repeat(64), op]);
    };
    await bind("op-mig-1", "token-mig-000000001");
    const data = await appData(h);
    await inTransaction(h, OWNERSHIP_DOWN);
    for (const t of OWNERSHIP_TABLES) expect(await tableExists(h, t)).toBe(false);
    expect(await appData(h)).toEqual(data);
    expect((await h.pool.query("SELECT etsy_taxonomy_id, etsy_quantity FROM products WHERE id = 'prod-1'")).rows[0]).toEqual({ etsy_taxonomy_id: "tax-77", etsy_quantity: 3 });
    for (const ddl of [PHOTO_0040, PHOTO_0041]) await inTransaction(h, ddl);
    await bind("op-mig-2", "token-mig-000000002"); // re-applied ownership schema is fully usable alongside 0039
    expect(Number((await h.pool.query("SELECT COUNT(*) AS n FROM photo_w2_upload_intents")).rows[0].n)).toBe(1);
  }));
});
