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
  ensureMarketplaceSyncTables(sqlite);
  ensureStockSyncTables(sqlite);
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
`);}


const MARKETPLACE_ORDER_SYNC_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "import_status", ddl: "TEXT NOT NULL DEFAULT 'pending'" },
  { name: "attempt_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "last_error", ddl: "TEXT" },
  { name: "last_error_type", ddl: "TEXT" },
  { name: "retryable", ddl: "INTEGER NOT NULL DEFAULT 1" },
];

function ensureMarketplaceSyncTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS marketplace_webhook_events (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_event_id TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL, signature_valid INTEGER NOT NULL DEFAULT 0, payload_snapshot TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, received_at TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_channel_external ON marketplace_webhook_events(channel, external_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_channel_status ON marketplace_webhook_events(channel, status);
CREATE INDEX IF NOT EXISTS idx_webhook_received ON marketplace_webhook_events(received_at);
CREATE TABLE IF NOT EXISTS marketplace_orders (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_order_id TEXT NOT NULL, external_order_number TEXT, marketplace_connection_id TEXT NOT NULL, internal_order_id TEXT, status TEXT NOT NULL, import_status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_error_type TEXT, retryable INTEGER NOT NULL DEFAULT 1, currency TEXT NOT NULL, subtotal REAL NOT NULL, shipping REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL, buyer_email TEXT, buyer_name TEXT, shipping_address_snapshot TEXT, billing_address_snapshot TEXT, raw_payload_snapshot TEXT NOT NULL, ordered_at TEXT NOT NULL, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_channel_external ON marketplace_orders(channel, external_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_channel_status ON marketplace_orders(channel, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_connection ON marketplace_orders(marketplace_connection_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_ordered ON marketplace_orders(ordered_at);
CREATE TABLE IF NOT EXISTS marketplace_order_items (id TEXT PRIMARY KEY, marketplace_order_id TEXT NOT NULL, external_order_item_id TEXT, external_listing_id TEXT, product_id TEXT, sku TEXT, title_snapshot TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_marketplace_items_order ON marketplace_order_items(marketplace_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_product ON marketplace_order_items(product_id);
CREATE TABLE IF NOT EXISTS marketplace_import_attempts (id TEXT PRIMARY KEY, marketplace_order_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, error_type TEXT, error_message TEXT, retryable INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_marketplace_import_attempts_order ON marketplace_import_attempts(marketplace_order_id);
CREATE TABLE IF NOT EXISTS marketplace_sync_runs (id TEXT PRIMARY KEY, channel TEXT NOT NULL, sync_type TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, processed_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_sync_runs_channel_status ON marketplace_sync_runs(channel, status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON marketplace_sync_runs(started_at);
`);
  const existing = new Set((sqlite.prepare("PRAGMA table_info(marketplace_orders)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of MARKETPLACE_ORDER_SYNC_COLUMNS) {
    if (!existing.has(column.name)) sqlite.exec(`ALTER TABLE marketplace_orders ADD COLUMN ${column.name} ${column.ddl}`);
  }
}



function ensureStockSyncTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS background_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, channel TEXT, product_id TEXT, external_listing_id TEXT, payload_snapshot TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5, run_after TEXT NOT NULL, locked_at TEXT, locked_by TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), completed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_background_jobs_status_run ON background_jobs(status, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_background_jobs_type ON background_jobs(type);
CREATE INDEX IF NOT EXISTS idx_background_jobs_channel ON background_jobs(channel);
CREATE INDEX IF NOT EXISTS idx_background_jobs_product ON background_jobs(product_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_external_listing ON background_jobs(external_listing_id);
CREATE TABLE IF NOT EXISTS marketplace_inventory_snapshots (id TEXT PRIMARY KEY, channel TEXT NOT NULL, product_id TEXT NOT NULL, external_listing_id TEXT NOT NULL, local_stock INTEGER NOT NULL, marketplace_stock INTEGER NOT NULL, captured_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_listing ON marketplace_inventory_snapshots(channel, external_listing_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_product ON marketplace_inventory_snapshots(product_id, captured_at);
CREATE TABLE IF NOT EXISTS stock_sync_conflicts (id TEXT PRIMARY KEY, channel TEXT NOT NULL, product_id TEXT, external_listing_id TEXT, conflict_type TEXT NOT NULL, status TEXT NOT NULL, local_stock INTEGER, marketplace_stock INTEGER, details_snapshot TEXT, resolution TEXT, detected_at TEXT NOT NULL, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_stock_sync_conflicts_open ON stock_sync_conflicts(status, channel, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_conflicts_listing ON stock_sync_conflicts(external_listing_id);
CREATE TABLE IF NOT EXISTS stock_sync_audit (id TEXT PRIMARY KEY, job_id TEXT, channel TEXT NOT NULL, product_id TEXT NOT NULL, external_listing_id TEXT, previous_marketplace_stock INTEGER, requested_marketplace_stock INTEGER NOT NULL, confirmed_marketplace_stock INTEGER, result_status TEXT NOT NULL, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_job ON stock_sync_audit(job_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_listing ON stock_sync_audit(channel, external_listing_id, created_at);
`);
}
