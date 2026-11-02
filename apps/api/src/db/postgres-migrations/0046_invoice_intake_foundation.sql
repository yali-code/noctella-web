-- PHASE-2A invoice intake foundation. Forward-only and purely additive: three new tables and their indexes;
-- no existing table or column is touched. 0042 stays intentionally unused. Money uses numeric(18,6), the
-- project's PostgreSQL money type. Files live under INVOICE_FILE_DIR; only a relative path is stored.
CREATE TABLE IF NOT EXISTS invoice_cost_sets (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'cancelled')),
  title text NOT NULL,
  purchase_id text,
  approved_by text,
  approved_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_cost_sets_status ON invoice_cost_sets(status, created_at);
CREATE TABLE IF NOT EXISTS invoice_intakes (
  id text PRIMARY KEY,
  cost_set_id text NOT NULL REFERENCES invoice_cost_sets(id),
  invoice_type text NOT NULL CHECK (invoice_type IN ('auction', 'transport', 'forwarder', 'other')),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'extracted', 'reviewed', 'cancelled')),
  file_relative_path text NOT NULL,
  file_sha256 text NOT NULL CHECK (length(file_sha256) = 64),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0),
  file_mime text NOT NULL CHECK (file_mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  original_filename_sanitized text,
  supplier_name text,
  supplier_vat_number text,
  platform text,
  invoice_number text,
  issue_date text,
  paid_date text,
  currency text,
  total_original numeric(18,6),
  vat_note text,
  reverse_charge boolean,
  lot_numbers text,
  extraction_json text,
  edits_json text,
  fx_rate numeric(18,6),
  fx_rate_date text,
  fx_source text,
  bank_debit_eur numeric(18,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_intakes_set_sha256 ON invoice_intakes(cost_set_id, file_sha256);
CREATE INDEX IF NOT EXISTS idx_invoice_intakes_set ON invoice_intakes(cost_set_id, created_at);
CREATE TABLE IF NOT EXISTS invoice_cost_set_items (
  id text PRIMARY KEY,
  cost_set_id text NOT NULL REFERENCES invoice_cost_sets(id),
  product_id text NOT NULL,
  value_weight_eur numeric(18,6),
  weight_source text CHECK (weight_source IN ('ai', 'admin')),
  alloc_lot_eur numeric(18,6),
  alloc_hammer_fee_eur numeric(18,6),
  alloc_premium_eur numeric(18,6),
  alloc_transport_eur numeric(18,6),
  alloc_forwarder_eur numeric(18,6),
  alloc_fx_diff_eur numeric(18,6),
  alloc_total_eur numeric(18,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_cost_set_items_set_product ON invoice_cost_set_items(cost_set_id, product_id);
