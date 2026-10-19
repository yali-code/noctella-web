/**
 * Stage 5 F2 closure Stage 1: upgrade compatibility of the F2 candidate schema over the RELEASED production database
 * shape (isolated Etsy Phase 1 release 23406f7: products carries the 0039 Etsy listing columns, added on SQLite by its
 * migrate.ts ETSY_LISTING_FORM_COLUMNS and on PostgreSQL by 0039). The fixture 0039 file is copied verbatim from
 * 23406f7. Asserts that the candidate's startup schema step (SQLite ensureSchema) and its additive migrations
 * (PostgreSQL 0040/0041/0043/0044) neither fail nor drop/alter released Etsy data, and are idempotent.
 * It does NOT prove Etsy FUNCTIONALITY on the candidate: the #471 stack does not contain the Etsy code (release blocker).
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

it("the released 0039 fixture is the 23-column additive Etsy migration (no drops, rewrites or defaults)", () => {
  expect(releasedEtsy0039.match(/ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_/g)).toHaveLength(23);
  expect(releasedEtsy0039).not.toMatch(/\b(DROP|UPDATE|DELETE|DEFAULT)\b/i);
  expect(RELEASED_SQLITE_ETSY_COLUMNS).toHaveLength(23);
});

describe("SQLite (production driver): candidate ensureSchema over the released Etsy database", () => {
  it("starts without error, preserves every released Etsy value and existing row, adds the F2 tables, and is idempotent", () => {
    const file = path.join(require("node:os").tmpdir(), `f2-release-${randomUUID()}.sqlite`); files.push(file);
    const db = new Database(file); db.pragma("foreign_keys = ON");
    try {
      // Released production shape: base schema + released Etsy columns (as the released ensureSchema appends them).
      ensureSchema(db);
      for (const t of F2_TABLES.slice().reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`); // the released build had no F2/FAZ A photo tables
      for (const [name, ddl] of RELEASED_SQLITE_ETSY_COLUMNS) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${ddl}`);
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
      const candidate = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f.localeCompare("0039") > 0).sort();
      expect(candidate).toEqual(["0040_photo_operation_ownership.sql", "0041_photo_w2_upload_intents.sql", "0043_photo_publication_intents.sql", "0044_photo_publication_copies.sql"]);
      for (let pass = 0; pass < 2; pass++) for (const f of candidate) await h.pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
      expect((await h.pool.query("SELECT * FROM products WHERE id = $1", [product])).rows[0]).toEqual(before);
      for (const t of F2_TABLES) expect((await h.pool.query("SELECT to_regclass($1) AS t", [t])).rows[0].t).not.toBeNull();
      expect((await h.pool.query("SELECT to_regclass('photo_derivative_operations') AS t")).rows[0].t).toBeNull(); // 0042 stays unregistered
    } finally { await h.close(); }
  });
});
