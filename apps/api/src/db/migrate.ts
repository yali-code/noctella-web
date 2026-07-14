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
  ensureOrderColumns(sqlite);
  ensureMarketplacePublishTables(sqlite);
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


const ORDER_COLUMNS: Array<{ table: string; name: string; ddl: string }> = [
  { table: "orders", name: "order_draft_id", ddl: "TEXT" },
  { table: "orders", name: "payment_reference", ddl: "TEXT" },
  { table: "order_items", name: "product_slug", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "order_items", name: "product_type", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "order_items", name: "product_image_url", ddl: "TEXT" },
];

function ensureOrderColumns(sqlite: Database.Database): void {
  for (const column of ORDER_COLUMNS) {
    const existing = new Set(
      (sqlite.prepare(`PRAGMA table_info(${column.table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!existing.has(column.name)) {
      sqlite.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.ddl}`);
    }
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_draft ON orders(order_draft_id)");
}


function ensureMarketplacePublishTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS marketplace_connections (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_label TEXT NOT NULL, external_account_id TEXT,
  encrypted_access_token TEXT, encrypted_refresh_token TEXT, token_expires_at TEXT, scopes TEXT,
  status TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_connections_channel_account ON marketplace_connections(channel, account_label);
CREATE INDEX IF NOT EXISTS idx_marketplace_connections_channel ON marketplace_connections(channel);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, payload_snapshot TEXT NOT NULL, external_listing_id TEXT,
  external_listing_url TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_product ON publish_jobs(product_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_channel ON publish_jobs(channel);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);
CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY, publish_job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  request_snapshot TEXT NOT NULL, response_snapshot TEXT, error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_job ON publish_attempts(publish_job_id);
CREATE TABLE IF NOT EXISTS external_listings (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT NOT NULL,
  external_listing_id TEXT NOT NULL, external_listing_url TEXT, external_status TEXT NOT NULL,
  payload_snapshot TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_listings_channel_external ON external_listings(channel, external_listing_id);
CREATE INDEX IF NOT EXISTS idx_external_listings_product ON external_listings(product_id);
CREATE INDEX IF NOT EXISTS idx_external_listings_channel ON external_listings(channel);
CREATE INDEX IF NOT EXISTS idx_external_listings_connection ON external_listings(connection_id);
`);
}
