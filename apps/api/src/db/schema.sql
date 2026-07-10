-- Sprint 2 schema: products, product_images, categories, collections.
-- Written as plain idempotent SQL and applied via ensureSchema() in
-- db/migrate.ts, since drizzle-kit's migration generator could not run in
-- this environment (version-detection issue unrelated to network access).

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id TEXT,
  display_image_url TEXT,
  seo_title TEXT,
  meta_description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  cover_image_url TEXT,
  seo_title TEXT,
  meta_description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS products (
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

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS ai_listing_drafts (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  generated_title TEXT,
  generated_description TEXT,
  generated_story TEXT,
  generated_condition_description TEXT,
  suggested_category_id TEXT,
  suggested_collection_id TEXT,
  suggested_eur_price REAL,
  suggested_usd_price REAL,
  suggested_minimum_offer_price REAL,
  seo_title TEXT,
  meta_description TEXT,
  keywords TEXT,
  shipping_note TEXT,
  customs_warning INTEGER,
  ai_confidence_score REAL,
  ai_model TEXT,
  generation_prompt_version TEXT,
  rejection_reason TEXT,
  reviewed_by_admin_user_id TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_type ON products(type);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection_id);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_ai_listing_drafts_product ON ai_listing_drafts(product_id);
CREATE INDEX IF NOT EXISTS idx_ai_listing_drafts_status ON ai_listing_drafts(status);
