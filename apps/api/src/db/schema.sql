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
  processing_status TEXT NOT NULL DEFAULT 'Ready',
  storage_key TEXT,
  thumbnail_storage_key TEXT,
  processing_error_code TEXT,
  processing_updated_at TEXT,
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
  offer_id TEXT UNIQUE,
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
  order_id TEXT,
  idempotency_key TEXT,
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
CREATE TABLE IF NOT EXISTS stock_sync_audit (id TEXT PRIMARY KEY, job_id TEXT, channel TEXT NOT NULL, product_id TEXT NOT NULL, external_listing_id TEXT, previous_marketplace_stock INTEGER, requested_marketplace_stock INTEGER NOT NULL, confirmed_marketplace_stock INTEGER, result_status TEXT NOT NULL, error_code TEXT, error_message TEXT, order_id TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_job ON stock_sync_audit(job_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_listing ON stock_sync_audit(channel, external_listing_id, created_at);

-- Sprint 14 shipping, tracking and complete sale workflow
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, marketplace_order_id TEXT, channel TEXT, carrier_code TEXT NOT NULL,
  custom_carrier_name TEXT, tracking_number TEXT, tracking_url TEXT, status TEXT NOT NULL, shipping_cost REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR', shipped_at TEXT, delivered_at TEXT, cancelled_at TEXT, returned_at TEXT,
  external_fulfillment_id TEXT, marketplace_fulfillment_status TEXT, last_error TEXT, customs_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_one_active_order ON shipments(order_id) WHERE status NOT IN ('cancelled','returned');
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipments_channel ON shipments(channel);
CREATE INDEX IF NOT EXISTS idx_shipments_carrier ON shipments(carrier_code);
CREATE TABLE IF NOT EXISTS shipment_items (id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, order_item_id TEXT NOT NULL, quantity INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_items_unique ON shipment_items(shipment_id, order_item_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id);
CREATE TABLE IF NOT EXISTS shipment_events (id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, event_type TEXT NOT NULL, previous_status TEXT, new_status TEXT, payload_snapshot TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events(shipment_id, created_at);
CREATE TABLE IF NOT EXISTS shipment_tracking_updates (id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, source TEXT NOT NULL, external_status TEXT, normalized_status TEXT, location TEXT, description TEXT, occurred_at TEXT, payload_snapshot TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_dedupe ON shipment_tracking_updates(shipment_id, source, external_status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tracking_shipment ON shipment_tracking_updates(shipment_id, created_at);
CREATE TABLE IF NOT EXISTS sale_financials (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, gross_revenue REAL NOT NULL, shipping_charged REAL NOT NULL, shipping_cost REAL NOT NULL, marketplace_fee REAL, promoted_fee REAL, payment_fee REAL, tax_vat REAL NOT NULL DEFAULT 0, item_cost REAL NOT NULL, net_revenue REAL NOT NULL, profit REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', source_snapshot TEXT NOT NULL, completed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE IF NOT EXISTS sale_completion_executions (idempotency_key TEXT PRIMARY KEY, payload_fingerprint TEXT NOT NULL, sale_id TEXT NOT NULL, result_payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_completion_executions_sale_unique ON sale_completion_executions(sale_id);

-- Sprint 15 returns, refunds and safe sale reversal.
CREATE TABLE IF NOT EXISTS return_requests (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, marketplace_order_id TEXT, shipment_id TEXT, channel TEXT, external_return_id TEXT, external_return_number TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, reason_details TEXT, requested_resolution TEXT NOT NULL, approved_resolution TEXT, buyer_message TEXT, internal_note TEXT, requested_at TEXT NOT NULL, authorized_at TEXT, received_at TEXT, inspected_at TEXT, completed_at TEXT, cancelled_at TEXT, return_carrier_code TEXT, return_tracking_number TEXT, return_tracking_url TEXT, buyer_shipped_at TEXT, last_error TEXT, external_reference TEXT, idempotency_key TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_requests_external_unique ON return_requests(channel, external_return_id) WHERE external_return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_return_requests_order ON return_requests(order_id); CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status); CREATE INDEX IF NOT EXISTS idx_return_requests_channel ON return_requests(channel); CREATE INDEX IF NOT EXISTS idx_return_requests_external ON return_requests(channel, external_return_id); CREATE INDEX IF NOT EXISTS idx_return_requests_dates ON return_requests(requested_at, completed_at);
CREATE TABLE IF NOT EXISTS return_items (id TEXT PRIMARY KEY, return_request_id TEXT NOT NULL, order_item_id TEXT NOT NULL, product_id TEXT, quantity_requested INTEGER NOT NULL, quantity_approved INTEGER, quantity_received INTEGER, condition TEXT, stock_disposition TEXT, inspection_note TEXT, inspection_result TEXT, quantity_completed INTEGER, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_items_unique ON return_items(return_request_id, order_item_id); CREATE INDEX IF NOT EXISTS idx_return_items_request ON return_items(return_request_id); CREATE INDEX IF NOT EXISTS idx_return_items_order_item ON return_items(order_item_id);
CREATE TABLE IF NOT EXISTS return_events (id TEXT PRIMARY KEY, return_request_id TEXT NOT NULL, event_type TEXT NOT NULL, previous_status TEXT, new_status TEXT, payload_snapshot TEXT, error_code TEXT, error_message TEXT, order_id TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_return_events_request ON return_events(return_request_id, created_at);
CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, return_request_id TEXT, channel TEXT, external_refund_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', subtotal_amount REAL NOT NULL, shipping_amount REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, marketplace_fee_adjustment REAL, payment_fee_adjustment REAL, total_amount REAL NOT NULL, reason TEXT, idempotency_key TEXT NOT NULL UNIQUE, submitted_at TEXT, succeeded_at TEXT, failed_at TEXT, last_error TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id); CREATE INDEX IF NOT EXISTS idx_refunds_return ON refunds(return_request_id); CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status); CREATE INDEX IF NOT EXISTS idx_refunds_channel ON refunds(channel); CREATE INDEX IF NOT EXISTS idx_refunds_external ON refunds(channel, external_refund_id); CREATE INDEX IF NOT EXISTS idx_refunds_created ON refunds(created_at);
CREATE TABLE IF NOT EXISTS refund_allocations (id TEXT PRIMARY KEY, refund_id TEXT NOT NULL, order_item_id TEXT, return_item_id TEXT, quantity INTEGER, amount REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_refund_allocations_refund ON refund_allocations(refund_id);
CREATE TABLE IF NOT EXISTS sale_reversals (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, return_request_id TEXT, refund_id TEXT, reversal_type TEXT NOT NULL, stock_reversed INTEGER NOT NULL DEFAULT 0, financials_reversed INTEGER NOT NULL DEFAULT 0, original_sale_financial_id TEXT, source_snapshot TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_sale_reversals_order ON sale_reversals(order_id); CREATE INDEX IF NOT EXISTS idx_sale_reversals_return ON sale_reversals(return_request_id);

CREATE TABLE IF NOT EXISTS refund_events (id TEXT PRIMARY KEY, refund_id TEXT NOT NULL, order_id TEXT, event_type TEXT NOT NULL, previous_status TEXT, new_status TEXT, payload_snapshot TEXT, actor TEXT, source TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_refund_events_refund ON refund_events(refund_id, created_at);
CREATE TABLE IF NOT EXISTS refund_attempts (id TEXT PRIMARY KEY, refund_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, channel TEXT, status TEXT NOT NULL, external_refund_id TEXT, request_snapshot TEXT NOT NULL, response_snapshot TEXT, error_code TEXT, error_message TEXT, order_id TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_refund_attempts_refund ON refund_attempts(refund_id); CREATE INDEX IF NOT EXISTS idx_refund_attempts_status ON refund_attempts(status);

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

-- Sprint 19 purchasing, suppliers and landed cost bridge.
CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, erp_reference_id TEXT, name TEXT NOT NULL, normalized_name TEXT NOT NULL, supplier_type TEXT NOT NULL, country_code TEXT, city TEXT, email TEXT, phone TEXT, website TEXT, tax_number TEXT, notes TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_erp_reference_unique ON suppliers(erp_reference_id) WHERE erp_reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);
CREATE INDEX IF NOT EXISTS idx_suppliers_ref ON suppliers(erp_reference_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_name_country ON suppliers(normalized_name, country_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_name_country_unique ON suppliers(normalized_name, country_code) WHERE country_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, erp_reference_id TEXT, supplier_id TEXT, source_type TEXT NOT NULL, external_reference TEXT, invoice_reference_number TEXT, auction_house TEXT, auction_date TEXT, currency TEXT NOT NULL DEFAULT 'EUR', item_subtotal REAL NOT NULL, buyer_premium REAL, shipping_cost REAL, customs_cost REAL, packaging_cost REAL, tax_vat REAL, miscellaneous_cost REAL, total_cost REAL, status TEXT NOT NULL, ordered_at TEXT, received_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_erp_reference_unique ON purchases(erp_reference_id) WHERE erp_reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_dates ON purchases(ordered_at, received_at);
CREATE INDEX IF NOT EXISTS idx_purchases_ref ON purchases(erp_reference_id, external_reference, invoice_reference_number);
CREATE TABLE IF NOT EXISTS purchase_lines (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, product_id TEXT, source_line_reference TEXT, title_snapshot TEXT NOT NULL, quantity INTEGER NOT NULL, received_quantity INTEGER NOT NULL DEFAULT 0, unit_purchase_cost REAL NOT NULL, weight REAL, manual_allocated_cost REAL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase ON purchase_lines(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_product ON purchase_lines(product_id);
CREATE TABLE IF NOT EXISTS purchase_allocations (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, purchase_line_id TEXT NOT NULL, product_id TEXT, allocation_method TEXT NOT NULL, allocated_shipping_cost REAL, allocated_customs_cost REAL, allocated_packaging_cost REAL, allocated_buyer_premium REAL, allocated_misc_cost REAL, allocated_tax_vat REAL, allocated_total_cost REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_purchase_allocations_purchase ON purchase_allocations(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_allocations_line ON purchase_allocations(purchase_line_id);
CREATE TABLE IF NOT EXISTS purchase_receipts (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_purchase_receipts_purchase ON purchase_receipts(purchase_id);
CREATE TABLE IF NOT EXISTS purchase_receipt_lines (id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, purchase_line_id TEXT NOT NULL, quantity_received INTEGER NOT NULL, stock_movement_id TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_purchase_receipt_lines_receipt ON purchase_receipt_lines(receipt_id);
CREATE TABLE IF NOT EXISTS purchase_events (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, event_type TEXT NOT NULL, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_purchase_events_purchase ON purchase_events(purchase_id, created_at);


-- Sprint 20 sales, invoices and finance bridge.
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, erp_reference_id TEXT, order_id TEXT NOT NULL, customer_id TEXT, invoice_number TEXT, invoice_type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', issued_at TEXT, due_at TEXT, paid_at TEXT, cancelled_at TEXT, seller_snapshot TEXT NOT NULL, customer_snapshot TEXT NOT NULL, billing_address_snapshot TEXT, shipping_address_snapshot TEXT, subtotal REAL NOT NULL, shipping_amount REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0, tax_vat_amount REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL, notes TEXT, source_snapshot TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_erp_reference_unique ON invoices(erp_reference_id) WHERE erp_reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number_unique ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id); CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id); CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status); CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(invoice_type); CREATE INDEX IF NOT EXISTS idx_invoices_dates ON invoices(issued_at, created_at);
CREATE TABLE IF NOT EXISTS invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, order_item_id TEXT, product_id TEXT, sku_snapshot TEXT, title_snapshot TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0, tax_vat_amount REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id); CREATE INDEX IF NOT EXISTS idx_invoice_lines_order_item ON invoice_lines(order_item_id); CREATE INDEX IF NOT EXISTS idx_invoice_lines_product ON invoice_lines(product_id);
CREATE TABLE IF NOT EXISTS invoice_events (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, event_type TEXT NOT NULL, previous_status TEXT, new_status TEXT, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id, created_at);
CREATE TABLE IF NOT EXISTS finance_entries (id TEXT PRIMARY KEY, order_id TEXT, invoice_id TEXT, refund_id TEXT, sale_reversal_id TEXT, entry_type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', amount REAL NOT NULL, source_reference TEXT NOT NULL, source_snapshot TEXT NOT NULL, idempotency_key TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_entries_idempotency_unique ON finance_entries(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_finance_entries_order ON finance_entries(order_id); CREATE INDEX IF NOT EXISTS idx_finance_entries_invoice ON finance_entries(invoice_id); CREATE INDEX IF NOT EXISTS idx_finance_entries_refund ON finance_entries(refund_id); CREATE INDEX IF NOT EXISTS idx_finance_entries_reversal ON finance_entries(sale_reversal_id); CREATE INDEX IF NOT EXISTS idx_finance_entries_type_date ON finance_entries(entry_type, occurred_at);

CREATE TABLE IF NOT EXISTS warehouses (id TEXT PRIMARY KEY, erp_reference_id TEXT UNIQUE, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL, country_code TEXT, city TEXT, address_summary TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE IF NOT EXISTS warehouse_locations (id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL, parent_location_id TEXT, erp_reference_id TEXT UNIQUE, code TEXT NOT NULL, name TEXT NOT NULL, location_type TEXT NOT NULL, status TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_locations_warehouse_code_unique ON warehouse_locations(warehouse_id, code);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_warehouse_status ON warehouse_locations(warehouse_id, status);
CREATE TABLE IF NOT EXISTS product_location_assignments (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, warehouse_location_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, reference_note TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_location_unique ON product_location_assignments(product_id, warehouse_location_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_location_one_primary ON product_location_assignments(product_id) WHERE is_primary = 1;
CREATE TABLE IF NOT EXISTS stock_reservations (id TEXT PRIMARY KEY, order_id TEXT, product_id TEXT NOT NULL, reservation_reference TEXT NOT NULL, reason TEXT NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL, expires_at TEXT, released_at TEXT, consumed_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_reservations_reference_active ON stock_reservations(reservation_reference, product_id) WHERE status = 'Active';
CREATE INDEX IF NOT EXISTS idx_stock_reservations_product_status ON stock_reservations(product_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_order_status ON stock_reservations(order_id, status);
CREATE TABLE IF NOT EXISTS picking_tasks (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, shipment_id TEXT, status TEXT NOT NULL, assigned_client_id TEXT, started_at TEXT, completed_at TEXT, cancelled_at TEXT, safe_notes TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_picking_tasks_order_status ON picking_tasks(order_id, status, created_at);
CREATE TABLE IF NOT EXISTS picking_task_lines (id TEXT PRIMARY KEY, picking_task_id TEXT NOT NULL, product_id TEXT NOT NULL, order_item_id TEXT, source_location_id TEXT, requested_quantity INTEGER NOT NULL, picked_quantity INTEGER NOT NULL DEFAULT 0, short_quantity INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_picking_task_lines_task ON picking_task_lines(picking_task_id);
CREATE TABLE IF NOT EXISTS packing_tasks (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, shipment_id TEXT, picking_task_id TEXT, status TEXT NOT NULL, package_count INTEGER NOT NULL DEFAULT 1, total_weight REAL, dimensions_snapshot TEXT, packing_materials_snapshot TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_packing_tasks_order_status ON packing_tasks(order_id, status, created_at);
CREATE TABLE IF NOT EXISTS packing_task_lines (id TEXT PRIMARY KEY, packing_task_id TEXT NOT NULL, product_id TEXT NOT NULL, order_item_id TEXT, quantity INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_packing_task_lines_task ON packing_task_lines(packing_task_id);
CREATE TABLE IF NOT EXISTS warehouse_events (id TEXT PRIMARY KEY, warehouse_id TEXT, location_id TEXT, product_id TEXT, order_id TEXT, shipment_id TEXT, reservation_id TEXT, picking_task_id TEXT, packing_task_id TEXT, event_type TEXT NOT NULL, safe_metadata TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE INDEX IF NOT EXISTS idx_warehouse_events_product_time ON warehouse_events(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_warehouse_events_order_time ON warehouse_events(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_warehouse_events_type_time ON warehouse_events(event_type, created_at);

-- Sprint 24 compatibility placeholders for domains previously served by adapters.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  status TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  idempotency_key TEXT NOT NULL UNIQUE,
  safe_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_reference ON payments(provider, provider_reference);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  phone TEXT,
  erp_reference_id TEXT UNIQUE,
  safe_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_unique ON customers(email);

CREATE TABLE IF NOT EXISTS erp_customer_links (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  erp_reference_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_erp_customer_links_customer ON erp_customer_links(customer_id);

-- Sprint 25 Unit of Work / transactional outbox foundation.
CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at TEXT NOT NULL, locked_at TEXT, locked_by TEXT, last_error_code TEXT, last_error_message TEXT, order_id TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), completed_at TEXT, dead_lettered_at TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_events_due ON outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_type ON outbox_events(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON outbox_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_locked ON outbox_events(locked_at);
CREATE TABLE IF NOT EXISTS outbox_attempts (id TEXT PRIMARY KEY, outbox_event_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, result TEXT NOT NULL, safe_error_code TEXT, safe_error_message TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_attempts_event ON outbox_attempts(outbox_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_return_requests_idempotency ON return_requests(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_events_idempotency ON return_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_return_items_product ON return_items(product_id);
