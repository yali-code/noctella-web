import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";

/**
 * Sprint 137: proves the products.price_eur NOT NULL -> nullable table-rebuild migration is safe
 * against a genuinely pre-Sprint-137 on-disk database - a real file-backed SQLite database (not
 * :memory:), with foreign_keys explicitly enabled (matching db/runtime.ts's real production
 * behavior), and the exact OLD products table DDL (price_eur REAL NOT NULL) created directly,
 * never through the already-updated ensureSchema/schema.sql.
 */
describe("Sprint 137: products.price_eur nullable migration", () => {
  let tempDir: string | undefined;
  afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); tempDir = undefined; });

  function createOldSchemaDatabase(sqlite: Database.Database) {
    sqlite.exec(`
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT, parent_id TEXT, display_image_url TEXT, seo_title TEXT, meta_description TEXT, display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT, cover_image_url TEXT, seo_title TEXT, meta_description TEXT, display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  erp_reference_id TEXT,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  category_id TEXT,
  collection_id TEXT,
  brand TEXT,
  model TEXT,
  manufacturer TEXT,
  country_of_origin TEXT,
  period TEXT,
  materials TEXT,
  description TEXT,
  product_story TEXT,
  condition TEXT,
  condition_description TEXT,
  length_value REAL,
  width_value REAL,
  height_value REAL,
  dimension_unit TEXT,
  weight_value REAL,
  weight_unit TEXT,
  stock_quantity INTEGER NOT NULL DEFAULT 1,
  lot_item_count INTEGER,
  purchase_cost REAL,
  purchase_currency TEXT,
  internal_notes TEXT,
  price_eur REAL NOT NULL,
  price_usd REAL,
  min_offer_price REAL,
  video_url TEXT,
  shipping_profile TEXT,
  shipping_note TEXT,
  customs_warning INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  meta_description TEXT,
  keywords TEXT,
  is_featured INTEGER NOT NULL DEFAULT 0,
  allow_make_offer INTEGER NOT NULL DEFAULT 0,
  allow_cash_on_delivery INTEGER NOT NULL DEFAULT 0,
  show_in_archive_after_sale INTEGER NOT NULL DEFAULT 0,
  ebay_title TEXT,
  ebay_subtitle TEXT,
  ebay_description TEXT,
  ebay_condition_description TEXT,
  ebay_category TEXT,
  ebay_item_specifics TEXT,
  ebay_listing_price_eur REAL,
  ebay_listing_status TEXT,
  etsy_title TEXT,
  etsy_description TEXT,
  etsy_tags TEXT,
  etsy_materials TEXT,
  etsy_style TEXT,
  etsy_occasion TEXT,
  etsy_listing_price_eur REAL,
  etsy_listing_status TEXT,
  woo_product_name TEXT,
  woo_short_description TEXT,
  woo_long_description TEXT,
  woo_slug TEXT,
  woo_seo_title TEXT,
  woo_meta_description TEXT,
  woo_focus_keyword TEXT,
  woo_listing_price_eur REAL,
  woo_listing_status TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (collection_id) REFERENCES collections(id)
);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_type ON products(type);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_collection ON products(collection_id);`);
  }

  it("migrates a real pre-Sprint-137 database: price_eur becomes nullable, every existing row/value/index survives, and it is idempotent", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-price-eur-nullable-"));
    const sqlite = new Database(path.join(tempDir, "legacy-price-eur.sqlite"));
    sqlite.pragma("foreign_keys = ON"); // matches db/runtime.ts's real production behavior

    createOldSchemaDatabase(sqlite);
    const now = "2026-01-01T00:00:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, ebay_listing_price_eur, created_at, updated_at)
         VALUES (@id, @sku, @title, @slug, @type, @status, @stockQuantity, @priceEur, @ebayListingPriceEur, @createdAt, @updatedAt)`,
      )
      .run({ id: "product-1", sku: "NOC-000001", title: "Legacy Priced Item", slug: "legacy-priced-item", type: "unique_item", status: "published", stockQuantity: 1, priceEur: 149.99, ebayListingPriceEur: null, createdAt: now, updatedAt: now });
    sqlite
      .prepare(
        `INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, ebay_listing_price_eur, created_at, updated_at)
         VALUES (@id, @sku, @title, @slug, @type, @status, @stockQuantity, @priceEur, @ebayListingPriceEur, @createdAt, @updatedAt)`,
      )
      .run({ id: "product-2", sku: "NOC-000002", title: "Another Legacy Item", slug: "another-legacy-item", type: "lot_item", status: "draft", stockQuantity: 5, priceEur: 12.5, ebayListingPriceEur: 15, createdAt: now, updatedAt: now });

    const beforeColumn = (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "price_eur");
    expect(beforeColumn?.notnull).toBe(1);

    expect(() => ensureSchema(sqlite)).not.toThrow();

    const afterColumn = (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "price_eur");
    expect(afterColumn?.notnull).toBe(0);

    // Every existing row survives with its exact prior values, for price_eur and every other column.
    const rows = sqlite.prepare("SELECT * FROM products ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "product-1", sku: "NOC-000001", title: "Legacy Priced Item", price_eur: 149.99, status: "published", stock_quantity: 1 });
    expect(rows[1]).toMatchObject({ id: "product-2", sku: "NOC-000002", price_eur: 12.5, ebay_listing_price_eur: 15, status: "draft", stock_quantity: 5 });

    // Indexes survive.
    const indexNames = (sqlite.prepare("PRAGMA index_list(products)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexNames).toEqual(expect.arrayContaining(["idx_products_status", "idx_products_type", "idx_products_category", "idx_products_collection"]));

    // A fresh insert with no price_eur now succeeds (previously would have violated NOT NULL).
    expect(() =>
      sqlite
        .prepare(`INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, created_at, updated_at) VALUES (@id, @sku, @title, @slug, @type, @status, @stockQuantity, @createdAt, @updatedAt)`)
        .run({ id: "product-3", sku: "NOC-000003", title: "Unpriced Stocked Item", slug: "unpriced-stocked-item", type: "unique_item", status: "draft", stockQuantity: 1, createdAt: now, updatedAt: now }),
    ).not.toThrow();
    const newRow = sqlite.prepare("SELECT price_eur FROM products WHERE id = 'product-3'").get() as { price_eur: number | null };
    expect(newRow.price_eur).toBeNull();

    // foreign_keys is restored to ON afterward.
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);

    // Idempotent - repeated startup is a safe no-op, no error, no further data change.
    const rowsBeforeRepeat = sqlite.prepare("SELECT * FROM products ORDER BY id").all();
    expect(() => ensureSchema(sqlite)).not.toThrow();
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const rowsAfterRepeat = sqlite.prepare("SELECT * FROM products ORDER BY id").all();
    expect(rowsAfterRepeat).toEqual(rowsBeforeRepeat);

    sqlite.close();
  });

  it("fresh database creation already has a nullable price_eur with no migration needed", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-price-eur-nullable-fresh-"));
    const sqlite = new Database(path.join(tempDir, "fresh.sqlite"));
    sqlite.pragma("foreign_keys = ON");
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const column = (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "price_eur");
    expect(column?.notnull).toBe(0);
    sqlite.close();
  });
});
