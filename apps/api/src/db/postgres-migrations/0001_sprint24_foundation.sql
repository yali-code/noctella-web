-- Sprint 24 complete additive PostgreSQL migration foundation.
-- No destructive DDL. SQLite remains authoritative until explicit future cutover.
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text ,
  parent_id text ,
  display_image_url text ,
  seo_title text ,
  meta_description text ,
  display_order integer NOT NULL DEFAULT 0,
  is_active integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_categories_sprint24_pk ON categories(id);
CREATE TABLE IF NOT EXISTS collections (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text ,
  cover_image_url text ,
  seo_title text ,
  meta_description text ,
  display_order integer NOT NULL DEFAULT 0,
  is_active integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_sprint24_pk ON collections(id);
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  erp_reference_id text ,
  sku text NOT NULL UNIQUE,
  title text NOT NULL,
  slug text NOT NULL UNIQUE,
  type text NOT NULL,
  status text NOT NULL,
  category_id text ,
  collection_id text ,
  brand text ,
  model text ,
  manufacturer text ,
  country_of_origin text ,
  period text ,
  materials text ,
  description text ,
  product_story text ,
  condition text ,
  condition_description text ,
  length_value numeric(18,6) ,
  width_value numeric(18,6) ,
  height_value numeric(18,6) ,
  dimension_unit text ,
  weight_value numeric(18,6) ,
  weight_unit numeric(18,6) ,
  stock_quantity integer NOT NULL DEFAULT 1,
  lot_item_count integer ,
  purchase_cost numeric(18,6) ,
  purchase_currency text ,
  internal_notes text ,
  price_eur numeric(18,6) NOT NULL,
  price_usd numeric(18,6) ,
  min_offer_price numeric(18,6) ,
  video_url text ,
  shipping_profile text ,
  shipping_note text ,
  customs_warning integer NOT NULL DEFAULT 0,
  seo_title text ,
  meta_description text ,
  keywords text ,
  is_featured integer NOT NULL DEFAULT 0,
  allow_make_offer integer NOT NULL DEFAULT 0,
  allow_cash_on_delivery integer NOT NULL DEFAULT 0,
  show_in_archive_after_sale integer NOT NULL DEFAULT 0,
  ebay_title text ,
  ebay_subtitle text ,
  ebay_description text ,
  ebay_condition_description text ,
  ebay_category text ,
  ebay_item_specifics text ,
  ebay_listing_price_eur numeric(18,6) ,
  ebay_listing_status text ,
  etsy_title text ,
  etsy_description text ,
  etsy_tags text ,
  etsy_materials text ,
  etsy_style text ,
  etsy_occasion text ,
  etsy_listing_price_eur numeric(18,6) ,
  etsy_listing_status text ,
  woo_product_name text ,
  woo_short_description text ,
  woo_long_description text ,
  woo_slug text ,
  woo_seo_title text ,
  woo_meta_description text ,
  woo_focus_keyword text ,
  woo_listing_price_eur numeric(18,6) ,
  woo_listing_status text ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_sprint24_pk ON products(id);
CREATE TABLE IF NOT EXISTS product_photos (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  url text NOT NULL,
  thumbnail_url text NOT NULL,
  alt_text text ,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary integer NOT NULL DEFAULT 0,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_photos_sprint24_pk ON product_photos(id);
CREATE TABLE IF NOT EXISTS product_images (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  url text NOT NULL,
  alt_text text ,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_images_sprint24_pk ON product_images(id);
CREATE TABLE IF NOT EXISTS ai_listing_drafts (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  status text NOT NULL,
  generated_title text ,
  generated_description text ,
  generated_story text ,
  generated_condition_description text ,
  suggested_category_id text ,
  suggested_collection_id text ,
  suggested_eur_price numeric(18,6) ,
  suggested_usd_price numeric(18,6) ,
  suggested_minimum_offer_price numeric(18,6) ,
  seo_title text ,
  meta_description text ,
  keywords text ,
  shipping_note text ,
  customs_warning integer ,
  ai_confidence_score numeric(18,6) ,
  ai_model text ,
  generation_prompt_version text ,
  rejection_reason text ,
  reviewed_by_admin_user_id text ,
  reviewed_at timestamptz ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_listing_drafts_sprint24_pk ON ai_listing_drafts(id);
CREATE TABLE IF NOT EXISTS offers (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  offered_amount numeric(18,6) NOT NULL,
  currency text NOT NULL,
  message text ,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_sprint24_pk ON offers(id);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  order_draft_id text UNIQUE,
  customer_id text ,
  guest_email text NOT NULL,
  status text NOT NULL,
  payment_status text NOT NULL,
  payment_provider text ,
  payment_reference text ,
  subtotal_amount numeric(18,6) NOT NULL,
  shipping_amount numeric(18,6) NOT NULL DEFAULT 0,
  tax_amount numeric(18,6) NOT NULL DEFAULT 0,
  total_amount numeric(18,6) NOT NULL,
  currency text NOT NULL,
  billing_address jsonb NOT NULL,
  shipping_address jsonb NOT NULL,
  notes text ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_sprint24_pk ON orders(id);
CREATE TABLE IF NOT EXISTS order_items (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  product_id text NOT NULL,
  product_sku text NOT NULL,
  product_title text NOT NULL,
  product_slug text NOT NULL,
  product_type text NOT NULL,
  product_image_url text ,
  quantity integer NOT NULL DEFAULT 1,
  unit_price numeric(18,6) NOT NULL,
  total_price numeric(18,6) NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_items_sprint24_pk ON order_items(id);
CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  order_id text ,
  provider text NOT NULL,
  status text NOT NULL,
  amount numeric(18,6) NOT NULL,
  currency text NOT NULL DEFAULT 'EUR',
  idempotency_key text NOT NULL UNIQUE,
  safe_metadata jsonb ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_sprint24_pk ON payments(id);
CREATE TABLE IF NOT EXISTS stock_movements (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  type text NOT NULL,
  quantity_delta integer NOT NULL,
  stock_before integer NOT NULL,
  stock_after integer NOT NULL,
  order_id text ,
  order_item_id text ,
  note text ,
  created_by_admin_user_id text ,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_sprint24_pk ON stock_movements(id);
CREATE TABLE IF NOT EXISTS marketplace_connections (
  id text PRIMARY KEY,
  channel text NOT NULL,
  account_label text NOT NULL,
  external_account_id text ,
  encrypted_access_token text ,
  encrypted_refresh_token text ,
  token_expires_at timestamptz ,
  scopes text ,
  status text NOT NULL,
  last_error text ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_connections_sprint24_pk ON marketplace_connections(id);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload_snapshot jsonb NOT NULL,
  external_listing_id text ,
  external_listing_url text ,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_sprint24_pk ON publish_jobs(id);
CREATE TABLE IF NOT EXISTS publish_attempts (
  id text PRIMARY KEY,
  publish_job_id text NOT NULL,
  attempt_number integer NOT NULL,
  request_snapshot jsonb NOT NULL,
  response_snapshot jsonb ,
  error_code text ,
  error_message text ,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_sprint24_pk ON publish_attempts(id);
CREATE TABLE IF NOT EXISTS external_listings (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  channel text NOT NULL,
  connection_id text NOT NULL,
  external_listing_id text NOT NULL,
  external_listing_url text ,
  external_status text NOT NULL,
  payload_snapshot jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_external_listings_sprint24_pk ON external_listings(id);
CREATE TABLE IF NOT EXISTS marketplace_webhook_events (
  id text PRIMARY KEY,
  channel text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  signature_valid integer NOT NULL DEFAULT 0,
  payload_snapshot jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text ,
  received_at timestamptz NOT NULL,
  processed_at timestamptz ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_sprint24_pk ON marketplace_webhook_events(id);
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id text PRIMARY KEY,
  channel text NOT NULL,
  external_order_id text NOT NULL,
  external_order_number text ,
  marketplace_connection_id text NOT NULL,
  internal_order_id text ,
  status text NOT NULL,
  import_status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text ,
  last_error_type text ,
  retryable integer NOT NULL DEFAULT 1,
  currency text NOT NULL,
  subtotal numeric(18,6) NOT NULL,
  shipping numeric(18,6) NOT NULL DEFAULT 0,
  tax numeric(18,6) NOT NULL DEFAULT 0,
  total numeric(18,6) NOT NULL,
  buyer_email text ,
  buyer_name text ,
  shipping_address_snapshot jsonb ,
  billing_address_snapshot jsonb ,
  raw_payload_snapshot jsonb NOT NULL,
  ordered_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_sprint24_pk ON marketplace_orders(id);
CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id text PRIMARY KEY,
  marketplace_order_id text NOT NULL,
  external_order_item_id text ,
  external_listing_id text ,
  product_id text ,
  sku text ,
  title_snapshot jsonb NOT NULL,
  quantity integer NOT NULL,
  unit_price numeric(18,6) NOT NULL,
  line_total numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_sprint24_pk ON marketplace_order_items(id);
CREATE TABLE IF NOT EXISTS marketplace_sync_runs (
  id text PRIMARY KEY,
  channel text NOT NULL,
  sync_type text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz ,
  processed_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_error text ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_sync_runs_sprint24_pk ON marketplace_sync_runs(id);
CREATE TABLE IF NOT EXISTS marketplace_import_attempts (
  id text PRIMARY KEY,
  marketplace_order_id text NOT NULL,
  attempt_number integer NOT NULL,
  status text NOT NULL,
  error_type text ,
  error_message text ,
  retryable integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_import_attempts_sprint24_pk ON marketplace_import_attempts(id);
CREATE TABLE IF NOT EXISTS background_jobs (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_sprint24_pk ON background_jobs(id);
CREATE TABLE IF NOT EXISTS marketplace_inventory_snapshots (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_inventory_snapshots_sprint24_pk ON marketplace_inventory_snapshots(id);
CREATE TABLE IF NOT EXISTS stock_sync_conflicts (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_sync_conflicts_sprint24_pk ON stock_sync_conflicts(id);
CREATE TABLE IF NOT EXISTS stock_sync_audit (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_sprint24_pk ON stock_sync_audit(id);
CREATE TABLE IF NOT EXISTS shipments (
  id text PRIMARY KEY NOT NULL,
  custom_carrier_name numeric(18,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'EUR',
  external_fulfillment_id text ,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipments_sprint24_pk ON shipments(id);
CREATE TABLE IF NOT EXISTS shipment_items (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_items_sprint24_pk ON shipment_items(id);
CREATE TABLE IF NOT EXISTS shipment_events (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_events_sprint24_pk ON shipment_events(id);
CREATE TABLE IF NOT EXISTS shipment_tracking_updates (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_tracking_updates_sprint24_pk ON shipment_tracking_updates(id);
CREATE TABLE IF NOT EXISTS sale_financials (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_financials_sprint24_pk ON sale_financials(id);
CREATE TABLE IF NOT EXISTS return_requests (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_requests_sprint24_pk ON return_requests(id);
CREATE TABLE IF NOT EXISTS return_items (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_items_sprint24_pk ON return_items(id);
CREATE TABLE IF NOT EXISTS return_events (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_events_sprint24_pk ON return_events(id);
CREATE TABLE IF NOT EXISTS refunds (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_sprint24_pk ON refunds(id);
CREATE TABLE IF NOT EXISTS refund_allocations (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_allocations_sprint24_pk ON refund_allocations(id);
CREATE TABLE IF NOT EXISTS sale_reversals (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_reversals_sprint24_pk ON sale_reversals(id);
CREATE TABLE IF NOT EXISTS refund_attempts (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_attempts_sprint24_pk ON refund_attempts(id);
CREATE TABLE IF NOT EXISTS erp_integration_clients (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_integration_clients_sprint24_pk ON erp_integration_clients(id);
CREATE TABLE IF NOT EXISTS erp_integration_audit (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_integration_audit_sprint24_pk ON erp_integration_audit(id);
CREATE TABLE IF NOT EXISTS erp_sync_checkpoints (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_sync_checkpoints_sprint24_pk ON erp_sync_checkpoints(id);
CREATE TABLE IF NOT EXISTS erp_command_executions (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_command_executions_sprint24_pk ON erp_command_executions(id);
CREATE TABLE IF NOT EXISTS product_erp_metadata (
  product_id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_erp_metadata_sprint24_pk ON product_erp_metadata(id);
CREATE TABLE IF NOT EXISTS suppliers (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_sprint24_pk ON suppliers(id);
CREATE TABLE IF NOT EXISTS purchases (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchases_sprint24_pk ON purchases(id);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_sprint24_pk ON purchase_lines(id);
CREATE TABLE IF NOT EXISTS purchase_allocations (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_allocations_sprint24_pk ON purchase_allocations(id);
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_receipts_sprint24_pk ON purchase_receipts(id);
CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_receipt_lines_sprint24_pk ON purchase_receipt_lines(id);
CREATE TABLE IF NOT EXISTS purchase_events (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_events_sprint24_pk ON purchase_events(id);
CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY,
  email text ,
  display_name text ,
  phone text ,
  erp_reference_id text UNIQUE,
  safe_metadata jsonb ,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_sprint24_pk ON customers(id);
CREATE TABLE IF NOT EXISTS customer_addresses (
  id text PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_sprint24_pk ON customer_addresses(id);
CREATE TABLE IF NOT EXISTS customer_consents (
  id text PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS idx_customer_consents_sprint24_pk ON customer_consents(id);
CREATE TABLE IF NOT EXISTS customer_events (
  id text PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS idx_customer_events_sprint24_pk ON customer_events(id);
CREATE TABLE IF NOT EXISTS erp_customer_links (
  id text PRIMARY KEY,
  customer_id text NOT NULL,
  erp_reference_id text NOT NULL UNIQUE,
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_customer_links_sprint24_pk ON erp_customer_links(id);
CREATE TABLE IF NOT EXISTS invoices (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_sprint24_pk ON invoices(id);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_sprint24_pk ON invoice_lines(id);
CREATE TABLE IF NOT EXISTS invoice_events (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_events_sprint24_pk ON invoice_events(id);
CREATE TABLE IF NOT EXISTS finance_entries (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_entries_sprint24_pk ON finance_entries(id);
CREATE TABLE IF NOT EXISTS warehouses (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warehouses_sprint24_pk ON warehouses(id);
CREATE TABLE IF NOT EXISTS warehouse_locations (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_sprint24_pk ON warehouse_locations(id);
CREATE TABLE IF NOT EXISTS stock_reservations (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_sprint24_pk ON stock_reservations(id);
CREATE TABLE IF NOT EXISTS picking_tasks (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_picking_tasks_sprint24_pk ON picking_tasks(id);
CREATE TABLE IF NOT EXISTS picking_task_lines (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_picking_task_lines_sprint24_pk ON picking_task_lines(id);
CREATE TABLE IF NOT EXISTS packing_tasks (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_packing_tasks_sprint24_pk ON packing_tasks(id);
CREATE TABLE IF NOT EXISTS packing_task_lines (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_packing_task_lines_sprint24_pk ON packing_task_lines(id);
CREATE TABLE IF NOT EXISTS warehouse_events (
  id timestamptz PRIMARY KEY NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warehouse_events_sprint24_pk ON warehouse_events(id);
ALTER TABLE order_items ADD CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE product_photos ADD CONSTRAINT fk_product_photos_product FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_product FOREIGN KEY (product_id) REFERENCES products(id);
