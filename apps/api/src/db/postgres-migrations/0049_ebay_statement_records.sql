-- eBay statement records. Additive only: two new tables, no existing data changes.
-- Buyer names, usernames and postal codes are never stored. Rollback: drop both tables.
CREATE TABLE IF NOT EXISTS ebay_statement_imports (
  id text PRIMARY KEY,
  file_sha256 text NOT NULL,
  seller text,
  period_start text,
  period_end text,
  inserted_count integer NOT NULL,
  updated_count integer NOT NULL,
  unchanged_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ebay_statement_rows (
  id text PRIMARY KEY,
  row_type text NOT NULL,
  transaction_date text NOT NULL,
  order_number text,
  transaction_id text,
  reference_id text,
  item_id text,
  title text,
  custom_label text,
  ship_country text,
  ship_city text,
  item_subtotal_usd numeric(18,6) NOT NULL DEFAULT 0,
  shipping_usd numeric(18,6) NOT NULL DEFAULT 0,
  ebay_tax_usd numeric(18,6) NOT NULL DEFAULT 0,
  fees_usd numeric(18,6) NOT NULL DEFAULT 0,
  gross_usd numeric(18,6) NOT NULL DEFAULT 0,
  net_eur numeric(18,6) NOT NULL DEFAULT 0,
  exchange_rate numeric(18,6),
  funds_status text,
  payout_id text,
  payout_date text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ebay_statement_rows_date ON ebay_statement_rows(transaction_date, row_type);
CREATE INDEX IF NOT EXISTS idx_ebay_statement_rows_order ON ebay_statement_rows(order_number);
