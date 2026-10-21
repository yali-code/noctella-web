/**
 * Stage 5 F2 closure Stage 1: upgrade compatibility of the F2 candidate schema over the RELEASED production database
 * shape (isolated Etsy Phase 1 release 23406f7: products carries the 0039 Etsy listing columns, added on SQLite by its
 * migrate.ts ETSY_LISTING_FORM_COLUMNS and on PostgreSQL by 0039). The fixture 0039 file is copied verbatim from
 * 23406f7. Asserts that the candidate's startup schema step (SQLite ensureSchema) and its additive migrations
 * (PostgreSQL 0040/0041/0043/0044) neither fail nor drop/alter released Etsy data, and are idempotent.
 * On the composed candidate (release/f2-stage1-candidate) the Etsy code is integrated: the candidate itself declares the
 * released Etsy columns and ships the released 0039 byte-for-byte; the Etsy suites (etsyListingFormParity,
 * etsyPhase1MediaIntegration) prove the functionality.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const releasedEtsy0039 = fs.readFileSync(path.join(__dirname, "fixtures", "released-etsy", "0039_etsy_listing_form_parity.sql"), "utf8");
// Verbatim from 23406f7 apps/api/src/db/migrate.ts ETSY_LISTING_FORM_COLUMNS (SQLite path of the released build).
const RELEASED_SQLITE_ETSY_COLUMNS: Array<[string, string]> = [
  ["etsy_taxonomy_id", "TEXT"], ["etsy_shop_section_id", "TEXT"], ["etsy_quantity", "INTEGER"], ["etsy_sku", "TEXT"], ["etsy_who_made", "TEXT"],
  ["etsy_is_supply", "INTEGER"], ["etsy_when_made", "TEXT"], ["etsy_vintage_year", "INTEGER"], ["etsy_shipping_profile_id", "TEXT"],
  ["etsy_processing_profile_id", "TEXT"], ["etsy_return_policy_id", "TEXT"], ["etsy_renewal_option", "TEXT"], ["etsy_featured", "INTEGER"],
  ["etsy_ads_opt_in", "INTEGER"], ["etsy_restock_requests", "INTEGER"], ["etsy_gpsr_manufacturer_name", "TEXT"], ["etsy_gpsr_manufacturer_address", "TEXT"],
  ["etsy_gpsr_manufacturer_contact", "TEXT"], ["etsy_gpsr_responsible_person_name", "TEXT"], ["etsy_gpsr_responsible_person_address", "TEXT"],
  ["etsy_gpsr_responsible_person_contact", "TEXT"], ["etsy_gpsr_safety_information", "TEXT"], ["etsy_consumer_guarantee_info", "TEXT"],
];
const F2_TABLES = ["photo_operations", "photo_operation_generations", "photo_operation_artifacts", "photo_w2_upload_intents", "photo_publication_intents", "photo_executor_exit_records", "photo_publication_copies"];
const files: string[] = [];
afterAll(() => { for (const f of files) fs.rmSync(f, { force: true }); });

it("the candidate ships the released 0039 byte-for-byte and declares every released Etsy column (SQLite schema and price rebuild)", () => {
  const shipped = fs.readFileSync(path.join(__dirname, "../src/db/postgres-migrations/0039_etsy_listing_form_parity.sql"), "utf8").replace(/\r\n/g, "\n");
  expect(shipped).toBe(releasedEtsy0039.replace(/\r\n/g, "\n"));
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const columns = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const [name] of RELEASED_SQLITE_ETSY_COLUMNS) expect(columns).toContain(name);
  } finally { db.close(); }
  const migrate = fs.readFileSync(path.join(__dirname, "../src/db/migrate.ts"), "utf8");
  expect(migrate).toMatch(/\$\{ETSY_LISTING_FORM_COLUMNS\.map\(\(column\) => `  \$\{column\.name\} \$\{column\.ddl\},`\)\.join\("\\n"\)\}/); // price-rebuild column list
});

it("the released 0039 fixture is the 23-column additive Etsy migration (no drops, rewrites or defaults)", () => {
  expect(releasedEtsy0039.match(/ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_/g)).toHaveLength(23);
  expect(releasedEtsy0039).not.toMatch(/\b(DROP|UPDATE|DELETE|DEFAULT)\b/i);
  expect(RELEASED_SQLITE_ETSY_COLUMNS).toHaveLength(23);
});

// #475's missing order/catalog checks, adapted to the released fixture and the full current F2 schema.
// No historical down.sql is executed: current publication intent/copy evidence must remain intact.
describe.runIf(postgresTestConfigured)("PostgreSQL: reconcile historical photo-first migration order without dropping evidence", () => {
  const dir = path.join(__dirname, "../src/db/postgres-migrations");
  const photoMigrations = ["0040_photo_operation_ownership.sql", "0041_photo_w2_upload_intents.sql", "0043_photo_publication_intents.sql", "0044_photo_publication_copies.sql"];
  type Harness = Awaited<ReturnType<typeof createPostgresTestDb>>;
  async function apply(h: Harness, name: string) { await h.pool.query(fs.readFileSync(path.join(dir, name), "utf8")); }
  async function catalog(h: Harness) {
    const tables = ["products", "product_photos", ...F2_TABLES];
    const columns = (await h.pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, column_name`, [h.schemaName, tables])).rows;
    const constraints = (await h.pool.query(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = $1::regnamespace ORDER BY rel, conname`, [h.schemaName])).rows;
    // Disposable schema names differ; object definitions and defaults must otherwise agree exactly.
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).split(h.schemaName + ".").join(""));
    return normalize({ columns, constraints });
  }
  // Fresh schemas replay the migration chain over local Docker. Use the historical PostgreSQL compatibility
  // suite's bounded 180-second budget instead of Vitest's five-second unit-test default; assertions are unchanged.
  it("photo-first and Etsy-first orders yield the same catalog, preserve business rows and keep all 23 declared columns nullable", async () => {
    const catalogs: unknown[] = [];
    for (const photoFirst of [false, true]) {
      const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql");
      try {
        const category = randomUUID(), product = randomUUID();
        await h.pool.query("INSERT INTO categories (id, name, slug) VALUES ($1, 'Order test', $2)", [category, `order-${category}`]);
        await h.pool.query("INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES ($1, $2, 'Existing', $3, 'UniqueItem', 'Draft', $4)", [product, `ORDER-${product}`, `order-${product}`, category]);
        const before = (await h.pool.query("SELECT id, sku, title, slug, type, status, category_id FROM products WHERE id = $1", [product])).rows[0];
        if (!photoFirst) await h.pool.query(releasedEtsy0039);
        for (const name of photoMigrations) await apply(h, name);
        if (photoFirst) await h.pool.query(releasedEtsy0039);
        expect((await h.pool.query("SELECT id, sku, title, slug, type, status, category_id FROM products WHERE id = $1", [product])).rows[0]).toEqual(before);
        const columns = (await h.pool.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'products'", [h.schemaName])).rows;
        const declared = [...releasedEtsy0039.matchAll(/ALTER TABLE products ADD COLUMN IF NOT EXISTS (etsy_[a-z0-9_]+)/g)].map((m) => m[1]);
        expect(new Set(declared).size).toBe(23);
        for (const name of declared) expect(columns.find((c) => c.column_name === name)?.is_nullable).toBe("YES");
        for (const table of F2_TABLES) expect((await h.pool.query("SELECT to_regclass($1) AS t", [table])).rows[0].t).not.toBeNull();
        catalogs.push(await catalog(h));
      } finally { await h.close(); }
    }
    expect(catalogs[0]).toEqual(catalogs[1]);
  }, 180_000);

  it("a dependency-unsafe rollback attempt fails atomically and retains the current publication schema", async () => {
    const h = await createPostgresTestDb("0044_photo_publication_copies.sql");
    try {
      const before = await catalog(h);
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query("DROP TABLE photo_operations")).rejects.toMatchObject({ code: "2BP01" });
      } finally { await client.query("ROLLBACK"); client.release(); }
      expect(await catalog(h)).toEqual(before);
      for (const table of F2_TABLES) expect((await h.pool.query("SELECT to_regclass($1) AS t", [table])).rows[0].t).not.toBeNull();
    } finally { await h.close(); }
  }, 180_000);
});

describe("SQLite (production driver): candidate ensureSchema over the released Etsy database", () => {
  it("starts without error, preserves every released Etsy value and existing row, adds the F2 tables, and is idempotent", () => {
    const file = path.join(require("node:os").tmpdir(), `f2-release-${randomUUID()}.sqlite`); files.push(file);
    const db = new Database(file); db.pragma("foreign_keys = ON");
    try {
      // Released production shape: base schema + released Etsy columns (as the released ensureSchema appends them).
      ensureSchema(db);
      for (const t of F2_TABLES.slice().reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`); // the released build had no F2/FAZ A photo tables
      const present = new Set((db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name));
      for (const [name, ddl] of RELEASED_SQLITE_ETSY_COLUMNS) if (!present.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${ddl}`);
      const category = randomUUID(), product = randomUUID();
      db.prepare("INSERT INTO categories (id, name, slug) VALUES (?, 'Released', ?)").run(category, `released-${category}`);
      db.prepare("INSERT INTO products (id, sku, title, slug, type, status, category_id, price_eur, etsy_taxonomy_id, etsy_quantity, etsy_is_supply, etsy_gpsr_safety_information) VALUES (?, ?, 'Released product', ?, 'UniqueItem', 'Draft', ?, 12.5, '1234', 3, 0, 'safety text')")
        .run(product, `REL-${product}`, `rel-${product}`, category);
      const before = db.prepare("SELECT * FROM products WHERE id = ?").get(product);
      ensureSchema(db); // candidate startup
      ensureSchema(db); // restart: idempotent
      expect(db.prepare("SELECT * FROM products WHERE id = ?").get(product)).toEqual(before);
      const columns = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const [name] of RELEASED_SQLITE_ETSY_COLUMNS) expect(columns).toContain(name);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      for (const t of F2_TABLES) expect(tables).toContain(t);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { db.close(); }
  });
});

describe.runIf(postgresTestConfigured)("PostgreSQL (supported driver): 0040/0041/0043/0044 over the released 0039 database", () => {
  it("applies in order onto a 0038 + released-0039 database, preserves Etsy and existing rows, and re-applies idempotently", async () => {
    const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql");
    try {
      await h.pool.query(releasedEtsy0039);
      const category = randomUUID(), product = randomUUID();
      await h.pool.query("INSERT INTO categories (id, name, slug) VALUES ($1, 'Released', $2)", [category, `released-${category}`]);
      await h.pool.query("INSERT INTO products (id, sku, title, slug, type, status, category_id, etsy_taxonomy_id, etsy_quantity, etsy_is_supply, etsy_gpsr_safety_information) VALUES ($1, $2, 'Released product', $3, 'UniqueItem', 'Draft', $4, '1234', 3, false, 'safety text')",
        [product, `REL-${product}`, `rel-${product}`, category]);
      const before = (await h.pool.query("SELECT * FROM products WHERE id = $1", [product])).rows[0];
      const dir = path.join(__dirname, "../src/db/postgres-migrations");
      const candidate = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f.slice(0, 4) > "0039").sort();
      expect(candidate).toEqual(["0040_photo_operation_ownership.sql", "0041_photo_w2_upload_intents.sql", "0043_photo_publication_intents.sql", "0044_photo_publication_copies.sql"]);
      for (let pass = 0; pass < 2; pass++) for (const f of candidate) await h.pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
      expect((await h.pool.query("SELECT * FROM products WHERE id = $1", [product])).rows[0]).toEqual(before);
      for (const t of F2_TABLES) expect((await h.pool.query("SELECT to_regclass($1) AS t", [t])).rows[0].t).not.toBeNull();
      expect((await h.pool.query("SELECT to_regclass('photo_derivative_operations') AS t")).rows[0].t).toBeNull(); // 0042 stays unregistered
    } finally { await h.close(); }
  });
});
