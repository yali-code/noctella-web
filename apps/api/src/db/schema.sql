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


CREATE TABLE IF NOT EXISTS product_photos (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id)
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
CREATE INDEX IF NOT EXISTS idx_product_photos_product ON product_photos(product_id);
CREATE INDEX IF NOT EXISTS idx_product_photos_product_sort ON product_photos(product_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_ai_listing_drafts_product ON ai_listing_drafts(product_id);
CREATE INDEX IF NOT EXISTS idx_ai_listing_drafts_status ON ai_listing_drafts(status);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  offered_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  order_draft_id TEXT UNIQUE,
  customer_id TEXT,
  guest_email TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  payment_provider TEXT,
  payment_reference TEXT,
  subtotal_amount REAL NOT NULL,
  shipping_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  billing_address TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  product_title TEXT NOT NULL,
  product_slug TEXT NOT NULL,
  product_type TEXT NOT NULL,
  product_image_url TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_draft ON orders(order_draft_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_guest_email ON orders(guest_email);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);


CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL,
  stock_before INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  order_id TEXT,
  order_item_id TEXT,
  note TEXT,
  created_by_admin_user_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (order_item_id) REFERENCES order_items(id)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order ON stock_movements(order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(type);

CREATE TABLE IF NOT EXISTS marketplace_connections (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  account_label TEXT NOT NULL,
  external_account_id TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  scopes TEXT,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_connections_channel_account ON marketplace_connections(channel, account_label);
CREATE INDEX IF NOT EXISTS idx_marketplace_connections_channel ON marketplace_connections(channel);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_snapshot TEXT NOT NULL,
  external_listing_id TEXT,
  external_listing_url TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  completed_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_product ON publish_jobs(product_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_channel ON publish_jobs(channel);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY,
  publish_job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  request_snapshot TEXT NOT NULL,
  response_snapshot TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_job ON publish_attempts(publish_job_id);

CREATE TABLE IF NOT EXISTS external_listings (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  external_listing_url TEXT,
  external_status TEXT NOT NULL,
  payload_snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (connection_id) REFERENCES marketplace_connections(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_listings_channel_external ON external_listings(channel, external_listing_id);
CREATE INDEX IF NOT EXISTS idx_external_listings_product ON external_listings(product_id);
CREATE INDEX IF NOT EXISTS idx_external_listings_channel ON external_listings(channel);
CREATE INDEX IF NOT EXISTS idx_external_listings_connection ON external_listings(connection_id);

CREATE TABLE IF NOT EXISTS marketplace_webhook_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  payload_snapshot TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_channel_external ON marketplace_webhook_events(channel, external_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_channel_status ON marketplace_webhook_events(channel, status);
CREATE INDEX IF NOT EXISTS idx_webhook_received ON marketplace_webhook_events(received_at);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  external_order_number TEXT,
  marketplace_connection_id TEXT NOT NULL,
  internal_order_id TEXT,
  status TEXT NOT NULL,
  import_status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_type TEXT,
  retryable INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL,
  subtotal REAL NOT NULL,
  shipping REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  buyer_email TEXT,
  buyer_name TEXT,
  shipping_address_snapshot TEXT,
  billing_address_snapshot TEXT,
  raw_payload_snapshot TEXT NOT NULL,
  ordered_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (marketplace_connection_id) REFERENCES marketplace_connections(id),
  FOREIGN KEY (internal_order_id) REFERENCES orders(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_channel_external ON marketplace_orders(channel, external_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_channel_status ON marketplace_orders(channel, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_connection ON marketplace_orders(marketplace_connection_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_ordered ON marketplace_orders(ordered_at);

CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id TEXT PRIMARY KEY,
  marketplace_order_id TEXT NOT NULL,
  external_order_item_id TEXT,
  external_listing_id TEXT,
  product_id TEXT,
  sku TEXT,
  title_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (marketplace_order_id) REFERENCES marketplace_orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_order ON marketplace_order_items(marketplace_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_product ON marketplace_order_items(product_id);

CREATE TABLE IF NOT EXISTS marketplace_import_attempts (
  id TEXT PRIMARY KEY,
  marketplace_order_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_type TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (marketplace_order_id) REFERENCES marketplace_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_import_attempts_order ON marketplace_import_attempts(marketplace_order_id);

CREATE TABLE IF NOT EXISTS marketplace_sync_runs (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_channel_status ON marketplace_sync_runs(channel, status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON marketplace_sync_runs(started_at);

-- Sprint 13: marketplace stock sync and background jobs.
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
