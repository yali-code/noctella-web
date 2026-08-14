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
  ensureShippingTables(sqlite);
  ensureReturnRefundTables(sqlite);
  ensureErpIntegrationTables(sqlite);
  ensurePurchasingTables(sqlite);
  ensureSalesFinanceBridgeTables(sqlite);
  ensureCustomerBridgeTables(sqlite);
  ensureSprint25OutboxTables(sqlite);
  ensurePaymentColumns(sqlite);
  ensureAuthTables(sqlite);
  ensureCompanyProfileTable(sqlite);
  ensureInvoiceAccountingColumns(sqlite);
  ensureOrderStatusCasingNormalized(sqlite);
  ensureAiListingDraftColumns(sqlite);
  ensureAiProductIntakeAppliedColumns(sqlite);
  ensureAiProductIntakeFinalizationColumns(sqlite);
  ensureAiIntakeProposalStockAcceptanceColumns(sqlite);
  ensureProductSkuSequenceTable(sqlite);
  ensureMarketplacePreparationsTable(sqlite);
  ensureShippingMethodsTable(sqlite);
  ensureProductPriceEurNullable(sqlite);
  ensureMarketingTagsTables(sqlite);
  ensureCanonicalProductAiProposalsTable(sqlite);
}

/**
 * Sprint 137: relaxes products.price_eur from NOT NULL to nullable, so a warehouse-created
 * Draft Product can exist without a sales price. SQLite has no ALTER TABLE ... ALTER COLUMN to
 * drop a NOT NULL constraint from an existing column - schema.sql's own CREATE TABLE IF NOT
 * EXISTS is a no-op on an already-existing products table, exactly like every other structural
 * change in this file's history, so this uses SQLite's own documented safe table-rebuild
 * procedure (https://www.sqlite.org/lang_altertable.html#otheralter): build a new table with the
 * identical column list/order/defaults/constraints except price_eur's relaxed NOT NULL, copy
 * every row across via `SELECT *` (safe because column order is unchanged), drop the old table,
 * rename the new one in, then recreate the four indexes schema.sql itself declares on products.
 * No column is added, removed, renamed, or reordered; no default changes; no existing value is
 * modified - every row keeps its exact current price_eur (or any other column) value.
 *
 * Idempotent: checked via PRAGMA table_info before doing anything - a database that already has
 * a nullable price_eur (fresh install via the updated schema.sql, or an already-migrated
 * database) is left untouched, so this is safe to call unconditionally on every startup.
 *
 * foreign_keys must be toggled OFF before, and back ON after, the rebuild - other tables hold
 * `FOREIGN KEY (product_id) REFERENCES products(id)`, and runtime.ts always enables
 * `PRAGMA foreign_keys = ON` before ensureSchema runs, so dropping products mid-rebuild would
 * otherwise violate referencing rows. SQLite documents that this PRAGMA only takes effect
 * outside an active transaction, so it is toggled here, not inside the rebuild transaction
 * itself. PRAGMA foreign_key_check runs immediately after commit as a defensive integrity
 * verification before foreign_keys is turned back on.
 */
function ensureProductPriceEurNullable(sqlite: Database.Database): void {
  const priceColumn = (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string; notnull: number }>).find(
    (row) => row.name === "price_eur",
  );
  if (!priceColumn || priceColumn.notnull === 0) return; // already nullable (fresh install or already migrated) - no-op

  const wasForeignKeysOn = (sqlite.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (wasForeignKeysOn) sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.transaction(() => {
      sqlite.exec(`
CREATE TABLE products_price_eur_nullable_rebuild (
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
  price_eur REAL,
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
INSERT INTO products_price_eur_nullable_rebuild SELECT * FROM products;
DROP TABLE products;
ALTER TABLE products_price_eur_nullable_rebuild RENAME TO products;
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_type ON products(type);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection_id);`);
    })();

    const violations = sqlite.pragma("foreign_key_check(products)") as unknown[];
    if (violations.length > 0) {
      throw new Error(`Sprint 137 products.price_eur migration left ${violations.length} foreign key violation(s) - aborting.`);
    }
  } finally {
    if (wasForeignKeysOn) sqlite.pragma("foreign_keys = ON");
  }
}

/** Sprint 134: Admin-configurable checkout-time shipping methods - see schema.sqlite.ts's shippingMethods table doc comment. */
function ensureShippingMethodsTable(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS shipping_methods (id TEXT PRIMARY KEY, label TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, rule_type TEXT NOT NULL, flat_amount_eur_cents INTEGER, free_threshold_eur_cents INTEGER, country_codes TEXT, shipping_profiles TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_shipping_methods_active_sort ON shipping_methods(is_active, sort_order);`);
}

/**
 * Sprint 106: additive migration for the AI Full Product Analysis expanded
 * suggestion columns - `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op
 * for the already-existing ai_intake_proposals table (Sprint 93), matching
 * the same established ensureAiProductIntakeAppliedColumns pattern. No
 * backfill: existing proposal rows keep every new column NULL, correctly
 * reflecting that they were generated before these fields existed.
 */
function ensureAiIntakeProposalStockAcceptanceColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(ai_intake_proposals)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const columns: Array<{ name: string; ddl: string }> = [
    { name: "suggested_category_id", ddl: "TEXT" },
    { name: "suggested_brand", ddl: "TEXT" },
    { name: "suggested_model", ddl: "TEXT" },
    { name: "suggested_manufacturer", ddl: "TEXT" },
    { name: "suggested_country_of_origin", ddl: "TEXT" },
    { name: "suggested_period", ddl: "TEXT" },
    { name: "suggested_materials", ddl: "TEXT" },
    { name: "suggested_condition", ddl: "TEXT" },
    { name: "suggested_condition_description", ddl: "TEXT" },
    { name: "suggested_seo_title", ddl: "TEXT" },
    { name: "suggested_meta_description", ddl: "TEXT" },
    { name: "suggested_price_eur", ddl: "REAL" },
  ];
  for (const column of columns) {
    if (!existing.has(column.name)) sqlite.exec(`ALTER TABLE ai_intake_proposals ADD COLUMN ${column.name} ${column.ddl}`);
  }
}

/**
 * Sprint 106: the single persisted counter row source for system-generated
 * Product SKUs (NOC-000001, NOC-000002, ...) - see
 * repositories/product-write/drizzle.ts's allocateNextProductSkuInTransaction.
 * A new, narrowly-scoped table, not an ALTER of an existing one.
 */
function ensureProductSkuSequenceTable(sqlite: Database.Database): void {
  sqlite.exec("CREATE TABLE IF NOT EXISTS product_sku_sequence (id TEXT PRIMARY KEY, next_value INTEGER NOT NULL);");
}

/**
 * Sprint 107: the in-flight, unapproved AI marketplace-preparation proposal
 * table - see schema.sqlite.ts's marketplacePreparations for the full
 * rationale. A new, narrowly-scoped table (one row per productId+channel),
 * not an ALTER of an existing one.
 */
function ensureMarketplacePreparationsTable(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS marketplace_preparations (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  base_product_updated_at TEXT NOT NULL, suggested_title TEXT, suggested_description TEXT,
  suggested_condition_description TEXT, suggested_item_specifics TEXT, suggested_tags TEXT,
  suggested_materials TEXT, suggested_style TEXT, suggested_occasion TEXT, suggested_short_description TEXT,
  suggested_seo_title TEXT, suggested_meta_description TEXT, suggested_focus_keyword TEXT,
  provider_name TEXT NOT NULL, prompt_version TEXT NOT NULL, generated_at TEXT NOT NULL,
  applied_at TEXT, applied_by_admin_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_preparations_product_channel ON marketplace_preparations(product_id, channel);
`);
}

/**
 * Sprint 140: the normalized Product Marketing Tag taxonomy - additive only, mirrors
 * ensureMarketplacePreparationsTable's exact idempotent-CREATE-TABLE pattern. No FK constraint on
 * product_marketing_tags, matching this schema's established convention.
 */
function ensureMarketingTagsTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS marketing_tags (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_tags_key_unique ON marketing_tags(key);
CREATE TABLE IF NOT EXISTS product_marketing_tags (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, marketing_tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_marketing_tags_unique ON product_marketing_tags(product_id, marketing_tag_id);
`);
}

/**
 * Sprint 148: the isolated, non-channel-scoped canonical Product AI proposal table - see
 * schema.sqlite.ts's canonicalProductAiProposals for the full rationale. A new, narrowly-scoped
 * table (one row per product_id), mirrors ensureMarketplacePreparationsTable's exact idempotent
 * pattern. Postgres-side equivalent: db/postgres-migrations/0018_sprint148_canonical_product_ai_proposals.sql.
 */
function ensureCanonicalProductAiProposalsTable(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS canonical_product_ai_proposals (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  base_product_updated_at TEXT NOT NULL,
  suggested_brand TEXT, suggested_model TEXT, suggested_manufacturer TEXT, suggested_country_of_origin TEXT,
  suggested_period TEXT, suggested_materials TEXT, suggested_description TEXT, suggested_product_story TEXT,
  suggested_condition TEXT, suggested_condition_description TEXT,
  suggested_length_value REAL, suggested_width_value REAL, suggested_height_value REAL, suggested_dimension_unit TEXT,
  suggested_weight_value REAL, suggested_weight_unit TEXT, suggested_marketing_tags TEXT,
  provider_name TEXT NOT NULL, prompt_version TEXT NOT NULL, generated_at TEXT NOT NULL,
  applied_at TEXT, applied_by_admin_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_product_ai_proposals_product ON canonical_product_ai_proposals(product_id);
`);
}

/**
 * Sprint 94 correction: additive migration for the Save as Draft apply audit
 * columns. `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op for the
 * already-existing ai_product_intakes table (Sprint 90/93), matching the
 * same established pattern as ensureAiListingDraftColumns/ensurePaymentColumns/
 * ensureMarketplaceColumns - new nullable columns are added here, never by
 * editing the original CREATE TABLE block. No backfill: existing rows keep
 * applied_at/applied_by_admin_user_id = NULL, correctly reflecting that they
 * were never applied.
 */
function ensureAiProductIntakeAppliedColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!existing.has("applied_at")) {
    sqlite.exec("ALTER TABLE ai_product_intakes ADD COLUMN applied_at TEXT");
  }
  if (!existing.has("applied_by_admin_user_id")) {
    sqlite.exec("ALTER TABLE ai_product_intakes ADD COLUMN applied_by_admin_user_id TEXT");
  }
}

/**
 * Sprint 95: additive migration for the photo-finalization audit columns,
 * matching the exact ensureAiProductIntakeAppliedColumns pattern above (and
 * the same established PRAGMA table_info + conditional ALTER TABLE ADD
 * COLUMN approach used throughout this file). Handles every starting shape
 * independently (neither column present, only one of the two present, or
 * both already present) and is safe to call repeatedly. No backfill:
 * existing rows keep finalized_at/finalized_by_admin_user_id = NULL,
 * correctly reflecting that they were never finalized.
 */
function ensureAiProductIntakeFinalizationColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!existing.has("finalized_at")) {
    sqlite.exec("ALTER TABLE ai_product_intakes ADD COLUMN finalized_at TEXT");
  }
  if (!existing.has("finalized_by_admin_user_id")) {
    sqlite.exec("ALTER TABLE ai_product_intakes ADD COLUMN finalized_by_admin_user_id TEXT");
  }
}

/**
 * Sprint 89: additive migration for the AI Draft generation-baseline column.
 * `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op for the already-existing
 * ai_listing_drafts table, matching the same established pattern as
 * ensureMarketplaceColumns/ensurePaymentColumns - new nullable columns are added
 * here, never by editing the original CREATE TABLE block. No backfill: existing
 * rows keep base_product_updated_at = NULL and must be regenerated before approval.
 */
function ensureAiListingDraftColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(ai_listing_drafts)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!existing.has("base_product_updated_at")) {
    sqlite.exec("ALTER TABLE ai_listing_drafts ADD COLUMN base_product_updated_at TEXT");
  }
}

/**
 * Sprint 80 correction: the sales-completion repository previously wrote the raw string
 * "Completed" (capital C) instead of the canonical OrderStatus enum value "completed" -
 * every comparison against OrderStatus.Completed elsewhere in the codebase (return eligibility,
 * ERP sale-projection completionStatus, the order status-transition table) silently never
 * matched a historically-completed order. The write path is now fixed (see
 * repositories/sales-completion/sqlite.ts and postgres.ts); this is the one-time, idempotent
 * backfill for rows a database may already have written with the old value before that fix
 * shipped - a plain UPDATE, never a schema change, safe to run on every startup.
 */
function ensureOrderStatusCasingNormalized(sqlite: Database.Database): void {
  sqlite.exec("UPDATE orders SET status = 'completed' WHERE status = 'Completed'");
}

/** Sprint 79: singleton company-profile settings table used as the invoice seller-snapshot source. */
function ensureCompanyProfileTable(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS company_profile (id TEXT PRIMARY KEY, legal_name TEXT NOT NULL, trade_name TEXT, registration_number TEXT NOT NULL, vat_number TEXT, address_line1 TEXT NOT NULL, address_line2 TEXT, city TEXT NOT NULL, postal_code TEXT NOT NULL, country TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, website TEXT, bank_name TEXT, iban TEXT, bic TEXT, invoice_footer TEXT, default_payment_terms_days INTEGER NOT NULL DEFAULT 14, default_vat_rate REAL NOT NULL DEFAULT 20, default_tax_treatment TEXT NOT NULL DEFAULT 'StandardVAT', default_prices_include_vat INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
`);
}

/**
 * Sprint 79 correction: `sales_invoice_order_key` replaces an earlier, unsafe design that created
 * `CREATE UNIQUE INDEX ... ON invoices(order_id) WHERE invoice_type='SalesInvoice'` directly.
 * SQLite validates existing data when a unique index is created — before this sprint, creating
 * more than one SalesInvoice per order (with distinct erpReferenceId values) was legal, so any
 * database already containing such a historical duplicate would have made that CREATE UNIQUE
 * INDEX throw on every single API startup (crash-looping the whole service). Historical duplicates
 * must never be deleted, cancelled, renumbered, or silently modified, and startup must always
 * succeed regardless of what pre-existing data looks like.
 *
 * Strategy: a nullable column, backfilled only for orders with exactly one SalesInvoice (the
 * unambiguous case), left NULL for any order with more than one (the historical duplicate case —
 * simply excluded from the unique index, not touched otherwise). The unique index is on this
 * nullable column, not on order_id directly, so it can never see two equal non-NULL values for a
 * pre-existing duplicate group. New SalesInvoice rows always set this column to their own order_id
 * (see erpSalesFinanceBridge.ts's createInvoiceDraft), so new duplicates are still prevented at
 * the database level going forward. Applic­ation-level duplicate detection (createInvoiceDraft's
 * own lookup-before-insert) is unaffected by this column and still finds ANY existing SalesInvoice
 * for an order, historical duplicates included, since it queries by (order_id, invoice_type)
 * directly, never by this new column.
 */
function ensureInvoiceAccountingColumns(sqlite: Database.Database): void {
  const invoiceColumns = new Set((sqlite.prepare("PRAGMA table_info(invoices)").all() as Array<{ name: string }>).map((row) => row.name));
  const additions: Array<{ name: string; ddl: string }> = [
    { name: "calculation_mode", ddl: "TEXT NOT NULL DEFAULT 'Automatic'" },
    { name: "tax_treatment", ddl: "TEXT NOT NULL DEFAULT 'StandardVAT'" },
    { name: "prices_include_vat", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { name: "shipping_vat_rate", ddl: "REAL NOT NULL DEFAULT 0" },
    { name: "shipping_vat_amount", ddl: "REAL NOT NULL DEFAULT 0" },
    { name: "invoice_footer", ddl: "TEXT" },
    { name: "sales_invoice_order_key", ddl: "TEXT" },
  ];
  for (const column of additions) if (!invoiceColumns.has(column.name)) sqlite.exec(`ALTER TABLE invoices ADD COLUMN ${column.name} ${column.ddl}`);

  // Backfill: unambiguous orders (exactly one SalesInvoice) get the key set to their order_id;
  // ambiguous (duplicate) groups are left NULL and reported, never modified further. Re-running
  // this on every startup is safe and idempotent — it only ever sets a NULL key to a value, never
  // clears or changes an already-set one, and an order that already has its key set is skipped
  // entirely by the WHERE clause below.
  sqlite.exec(`
    UPDATE invoices SET sales_invoice_order_key = order_id
    WHERE invoice_type = 'SalesInvoice' AND sales_invoice_order_key IS NULL
      AND (SELECT COUNT(*) FROM invoices AS dup WHERE dup.order_id = invoices.order_id AND dup.invoice_type = 'SalesInvoice') = 1
  `);
  const duplicateGroups = sqlite.prepare(`
    SELECT order_id, COUNT(*) AS count FROM invoices
    WHERE invoice_type = 'SalesInvoice' AND sales_invoice_order_key IS NULL
    GROUP BY order_id
  `).all() as Array<{ order_id: string; count: number }>;
  if (duplicateGroups.length) {
    // eslint-disable-next-line no-console
    console.warn(`[migrate] ${duplicateGroups.length} order(s) have more than one historical SalesInvoice row (pre-Sprint-79 state) and were left unmodified: ${duplicateGroups.map((g) => g.order_id).join(", ")}`);
  }

  // Sprint 79 second-review correction: a database that already ran an earlier (unsafe) draft of
  // this migration may still carry the old direct index this one replaces. That old index enforces
  // uniqueness on order_id directly, with no historical-duplicate exclusion, so it can still throw
  // "UNIQUE constraint failed: invoices.order_id" on a legitimate historical duplicate or a
  // concurrent-creation race — a raw error createInvoiceDraft's catch block does not recognize
  // (it only matches the new sales_invoice_order_key violation). Dropping it is safe: the new
  // partial unique index below already provides the intended, historical-duplicate-tolerant
  // constraint, and DROP INDEX IF EXISTS is a no-op on a database that never had it.
  sqlite.exec("DROP INDEX IF EXISTS idx_invoices_order_sales_invoice_unique");

  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_sales_invoice_order_key_unique ON invoices(sales_invoice_order_key) WHERE sales_invoice_order_key IS NOT NULL");

  const lineColumns = new Set((sqlite.prepare("PRAGMA table_info(invoice_lines)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!lineColumns.has("vat_rate")) sqlite.exec("ALTER TABLE invoice_lines ADD COLUMN vat_rate REAL NOT NULL DEFAULT 0");
}

/**
 * Sprint 79 correction: read-only operational report — historical SalesInvoice duplicate groups
 * that migration deliberately left unmodified (see ensureInvoiceAccountingColumns). Exposed via
 * the ERP bridge so an admin can see and manually resolve them without any automatic mutation.
 */
export function listHistoricalDuplicateSalesInvoiceOrderIds(sqlite: Database.Database): string[] {
  const rows = sqlite.prepare(`
    SELECT DISTINCT order_id FROM invoices
    WHERE invoice_type = 'SalesInvoice' AND sales_invoice_order_key IS NULL
  `).all() as Array<{ order_id: string }>;
  return rows.map((r) => r.order_id);
}

/** Sprint 64B: admin authentication foundation. */
function ensureAuthTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', session_version INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_user_id TEXT NOT NULL REFERENCES admin_users(id), session_version INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), last_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_user ON admin_sessions(admin_user_id);
CREATE TABLE IF NOT EXISTS admin_auth_events (id TEXT PRIMARY KEY, admin_user_id TEXT, email TEXT NOT NULL, event_type TEXT NOT NULL, ip_address TEXT, user_agent TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_admin_auth_events_email_created ON admin_auth_events(email, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_auth_events_admin_user ON admin_auth_events(admin_user_id);
`);
}

/**
 * Sprint 37A: additive migration for the `payments` table, which already
 * existed (Sprint 24 compatibility placeholder) before this column was
 * introduced — `CREATE TABLE IF NOT EXISTS` above is a no-op for it.
 */
function ensurePaymentColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!existing.has("provider_reference")) {
    sqlite.exec("ALTER TABLE payments ADD COLUMN provider_reference TEXT");
  }
  for (const [name, ddl] of [["provider_transaction_reference","TEXT"],["expected_amount_cents","INTEGER"],["checkout_snapshot","TEXT"]] as const) if (!existing.has(name)) sqlite.exec(`ALTER TABLE payments ADD COLUMN ${name} ${ddl}`);
  const duplicateSession = sqlite.prepare("SELECT provider, provider_reference FROM payments WHERE provider_reference IS NOT NULL GROUP BY provider, provider_reference HAVING COUNT(*) > 1 LIMIT 1").get();
  if (duplicateSession) throw new Error("PAYMENT_PROVIDER_REFERENCE_CONFLICT");
  const duplicateTransaction = sqlite.prepare("SELECT provider, provider_transaction_reference FROM payments WHERE provider_transaction_reference IS NOT NULL GROUP BY provider, provider_transaction_reference HAVING COUNT(*) > 1 LIMIT 1").get();
  if (duplicateTransaction) throw new Error("PAYMENT_PROVIDER_TRANSACTION_REFERENCE_CONFLICT");
  sqlite.exec("DROP INDEX IF EXISTS idx_payments_provider_reference");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference_unique ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_transaction_unique ON payments(provider, provider_transaction_reference) WHERE provider_transaction_reference IS NOT NULL");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_unique ON payments(order_id) WHERE order_id IS NOT NULL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, event_type TEXT NOT NULL, payment_id TEXT, status TEXT NOT NULL, result_classification TEXT, error_code TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)); CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_event_unique ON payment_events(provider, provider_event_id); CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events(payment_id)");
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
  { table: "orders", name: "offer_id", ddl: "TEXT" },
  { table: "orders", name: "payment_reference", ddl: "TEXT" },
  { table: "order_items", name: "product_slug", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "order_items", name: "product_type", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "order_items", name: "product_image_url", ddl: "TEXT" },
  // Sprint 134: immutable checkout-time shipping-method snapshot - see schema.sqlite.ts's orders table.
  { table: "orders", name: "shipping_method_id", ddl: "TEXT" },
  { table: "orders", name: "shipping_method_label", ddl: "TEXT" },
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
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_offer ON orders(offer_id)");
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


function ensureShippingTables(sqlite: Database.Database): void {
  const sqlPath = path.join(__dirname, "schema.sql");
  const all = fs.readFileSync(sqlPath, "utf-8");
  const marker = "-- Sprint 14 shipping, tracking and complete sale workflow";
  const chunk = all.includes(marker) ? all.slice(all.indexOf(marker)) : "";
  if (chunk) sqlite.exec(chunk);
}


function ensureReturnRefundTables(sqlite: Database.Database): void {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sqlText = fs.readFileSync(sqlPath, "utf-8");
  const marker = "-- Sprint 15 returns, refunds and safe sale reversal.";
  const index = sqlText.indexOf(marker);
  if (index >= 0) sqlite.exec(sqlText.slice(index));
}


function ensureErpIntegrationTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS erp_integration_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, key_version TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT, last_client_version TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_erp_clients_active ON erp_integration_clients(is_active);
CREATE INDEX IF NOT EXISTS idx_erp_clients_key_version ON erp_integration_clients(key_version);
CREATE TABLE IF NOT EXISTS erp_integration_audit (id TEXT PRIMARY KEY, client_id TEXT, request_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, result TEXT NOT NULL, safe_metadata TEXT, error_code TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_erp_audit_client ON erp_integration_audit(client_id);
CREATE INDEX IF NOT EXISTS idx_erp_audit_request ON erp_integration_audit(request_id);
CREATE INDEX IF NOT EXISTS idx_erp_audit_created ON erp_integration_audit(created_at);
CREATE TABLE IF NOT EXISTS erp_sync_checkpoints (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, request_id TEXT, checkpoint_token TEXT NOT NULL, acknowledged_at TEXT NOT NULL, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_checkpoints_request_unique ON erp_sync_checkpoints(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_checkpoints_client ON erp_sync_checkpoints(client_id);
CREATE INDEX IF NOT EXISTS idx_erp_checkpoints_token ON erp_sync_checkpoints(checkpoint_token);

-- Sprint 18 ERP inventory and product workspace bridge.
CREATE TABLE IF NOT EXISTS product_erp_metadata (product_id TEXT PRIMARY KEY, noctella_id TEXT, barcode_value TEXT, purchase_source TEXT, provenance TEXT, previous_owner TEXT, auction_house TEXT, invoice_reference_number TEXT, storage_location_reference TEXT, shipping_cost_eur REAL, packaging_cost_eur REAL, misc_costs_eur REAL, actual_sale_price_eur REAL, product_workflow_status TEXT, photo_status TEXT, authentication_status TEXT, marketplace_preparation_status TEXT, internal_priority TEXT, operational_notes TEXT, depth_value REAL, depth_unit TEXT, diameter_value REAL, diameter_unit TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_erp_metadata_noctella_unique ON product_erp_metadata(noctella_id) WHERE noctella_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_erp_metadata_noctella ON product_erp_metadata(noctella_id);
CREATE INDEX IF NOT EXISTS idx_product_erp_metadata_barcode ON product_erp_metadata(barcode_value);
CREATE INDEX IF NOT EXISTS idx_product_erp_metadata_location ON product_erp_metadata(storage_location_reference);
CREATE TABLE IF NOT EXISTS erp_command_executions (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, command_id TEXT NOT NULL, request_id TEXT, idempotency_key TEXT NOT NULL, command_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, status TEXT NOT NULL, result_reference TEXT, request_checksum TEXT NOT NULL, safe_result_metadata TEXT, safe_error_code TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), completed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_command_executions_client_key_unique ON erp_command_executions(client_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_erp_command_executions_client_key ON erp_command_executions(client_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_erp_command_executions_entity ON erp_command_executions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_erp_command_executions_status ON erp_command_executions(status, created_at);

`);
}


function ensurePurchasingTables(sqlite: Database.Database): void {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sqlText = fs.readFileSync(sqlPath, "utf-8");
  const marker = "-- Sprint 19 purchasing, suppliers and landed cost bridge.";
  const index = sqlText.indexOf(marker);
  if (index >= 0) sqlite.exec(sqlText.slice(index));
}


function ensureSalesFinanceBridgeTables(sqlite: Database.Database): void {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sqlText = fs.readFileSync(sqlPath, "utf-8");
  const marker = "-- Sprint 20 sales, invoices and finance bridge.";
  const index = sqlText.indexOf(marker);
  if (index >= 0) sqlite.exec(sqlText.slice(index));
}


function ensureCustomerBridgeTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS customer_profiles (id TEXT PRIMARY KEY, erp_reference_id TEXT, marketplace_buyer_id TEXT, email TEXT, phone TEXT, vat_number TEXT, name TEXT, status TEXT NOT NULL DEFAULT 'Active', source TEXT NOT NULL DEFAULT 'ERP', created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_profiles_email ON customer_profiles(email);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_phone ON customer_profiles(phone);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_erp ON customer_profiles(erp_reference_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_marketplace ON customer_profiles(marketplace_buyer_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_vat ON customer_profiles(vat_number);
CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT, line1 TEXT, line2 TEXT, city TEXT, region TEXT, postal_code TEXT, country TEXT, fingerprint TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_fingerprint ON customer_addresses(fingerprint);
CREATE TABLE IF NOT EXISTS customer_notes (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, archived_at TEXT, safe_metadata TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id, created_at);
CREATE TABLE IF NOT EXISTS customer_tags (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_tags_unique ON customer_tags(customer_id, tag);
CREATE TABLE IF NOT EXISTS customer_watchlist (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, reason TEXT, severity TEXT NOT NULL DEFAULT 'Info', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_watchlist_customer ON customer_watchlist(customer_id, active);
CREATE TABLE IF NOT EXISTS customer_events (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT, safe_metadata TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_events_customer ON customer_events(customer_id, occurred_at);
CREATE TABLE IF NOT EXISTS customer_statistics (customer_id TEXT PRIMARY KEY, lifetime_value REAL, order_count INTEGER, average_order_value REAL, refund_percent REAL, return_percent REAL, last_purchase_at TEXT, favourite_category TEXT, favourite_marketplace TEXT, favourite_brand TEXT, country TEXT, currency TEXT, customer_score REAL, days_since_last_purchase INTEGER, calculated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_preferences (customer_id TEXT PRIMARY KEY, language TEXT, currency TEXT, preferred_marketplace TEXT, safe_metadata TEXT, updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE IF NOT EXISTS customer_consents (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, consent_type TEXT NOT NULL, granted INTEGER NOT NULL, privacy_version TEXT, request_type TEXT, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_customer_consents_customer ON customer_consents(customer_id, created_at);
CREATE TABLE IF NOT EXISTS customer_merge_history (id TEXT PRIMARY KEY, source_customer_id TEXT NOT NULL, target_customer_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_merge_history_key ON customer_merge_history(idempotency_key);
CREATE TABLE IF NOT EXISTS customer_identity_links (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_identity_links_unique ON customer_identity_links(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_customer_identity_links_customer ON customer_identity_links(customer_id);
`);
}


function ensureSprint25OutboxTables(sqlite: Database.Database): void {
  const photoColumns = new Set((sqlite.prepare("PRAGMA table_info(product_photos)").all() as Array<{ name: string }>).map((row) => row.name));
  const columns: Array<{ name: string; ddl: string }> = [
    { name: "processing_status", ddl: "TEXT NOT NULL DEFAULT 'Ready'" },
    { name: "storage_key", ddl: "TEXT" },
    { name: "thumbnail_storage_key", ddl: "TEXT" },
    { name: "processing_error_code", ddl: "TEXT" },
    { name: "processing_updated_at", ddl: "TEXT" },
  ];
  for (const column of columns) if (!photoColumns.has(column.name)) sqlite.exec(`ALTER TABLE product_photos ADD COLUMN ${column.name} ${column.ddl}`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at TEXT NOT NULL, locked_at TEXT, locked_by TEXT, last_error_code TEXT, last_error_message TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), completed_at TEXT, dead_lettered_at TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_events_due ON outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_type ON outbox_events(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON outbox_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_locked ON outbox_events(locked_at);
CREATE TABLE IF NOT EXISTS outbox_attempts (id TEXT PRIMARY KEY, outbox_event_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, result TEXT NOT NULL, safe_error_code TEXT, safe_error_message TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_attempts_event ON outbox_attempts(outbox_event_id);`);
}
