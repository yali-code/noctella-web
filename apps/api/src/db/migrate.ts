import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Applies the Sprint 2 schema (idempotent CREATE TABLE IF NOT EXISTS
 * statements) to the given SQLite connection. Called on API startup and in
 * test setup so both share the same schema definition.
 */
export function ensureSchema(sqlite: Database.Database): void {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");
  sqlite.exec(sql);
  ensureMarketplaceColumns(sqlite);
}

/**
 * Sprint 3: additive migration for the marketplace data columns. Needed
 * because `CREATE TABLE IF NOT EXISTS` (above) is a no-op on a `products`
 * table that already existed from before Sprint 3 — it won't add new
 * columns to an existing table, so we add any missing ones here.
 */
const MARKETPLACE_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "ebay_title", ddl: "TEXT" },
  { name: "ebay_subtitle", ddl: "TEXT" },
  { name: "ebay_description", ddl: "TEXT" },
  { name: "ebay_condition_description", ddl: "TEXT" },
  { name: "ebay_category", ddl: "TEXT" },
  { name: "ebay_item_specifics", ddl: "TEXT" },
  { name: "ebay_listing_price_eur", ddl: "REAL" },
  { name: "ebay_listing_status", ddl: "TEXT" },
  { name: "etsy_title", ddl: "TEXT" },
  { name: "etsy_description", ddl: "TEXT" },
  { name: "etsy_tags", ddl: "TEXT" },
  { name: "etsy_materials", ddl: "TEXT" },
  { name: "etsy_style", ddl: "TEXT" },
  { name: "etsy_occasion", ddl: "TEXT" },
  { name: "etsy_listing_price_eur", ddl: "REAL" },
  { name: "etsy_listing_status", ddl: "TEXT" },
  { name: "woo_product_name", ddl: "TEXT" },
  { name: "woo_short_description", ddl: "TEXT" },
  { name: "woo_long_description", ddl: "TEXT" },
  { name: "woo_slug", ddl: "TEXT" },
  { name: "woo_seo_title", ddl: "TEXT" },
  { name: "woo_meta_description", ddl: "TEXT" },
  { name: "woo_focus_keyword", ddl: "TEXT" },
  { name: "woo_listing_price_eur", ddl: "REAL" },
  { name: "woo_listing_status", ddl: "TEXT" },
];

function ensureMarketplaceColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const column of MARKETPLACE_COLUMNS) {
    if (!existing.has(column.name)) {
      sqlite.exec(`ALTER TABLE products ADD COLUMN ${column.name} ${column.ddl}`);
    }
  }
}
