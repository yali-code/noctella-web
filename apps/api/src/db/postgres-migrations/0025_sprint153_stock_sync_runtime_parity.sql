DO $$
DECLARE
  target_table_name text;
  row_count bigint;
  actual_shape jsonb;
  expected_shape jsonb;
  id_type text;
  primary_key_count integer;
  primary_key_columns text;
BEGIN
  FOR target_table_name IN VALUES
    ('marketplace_inventory_snapshots'),
    ('stock_sync_conflicts'),
    ('stock_sync_audit')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', target_table_name) INTO row_count;
    SELECT
      jsonb_object_agg(c.column_name, jsonb_build_array(c.data_type, c.is_nullable, c.column_default IS NOT NULL)),
      max(CASE WHEN c.column_name = 'id' THEN c.data_type END)
      INTO actual_shape, id_type
      FROM information_schema.columns AS c
      WHERE c.table_schema = current_schema() AND c.table_name = target_table_name;

    SELECT
      count(DISTINCT con.oid),
      string_agg(a.attname, ',' ORDER BY key_column.ordinality)
      INTO primary_key_count, primary_key_columns
      FROM pg_catalog.pg_constraint AS con
      JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = rel.oid AND a.attnum = key_column.attnum
      WHERE ns.nspname = current_schema() AND rel.relname = target_table_name AND con.contype = 'p';

    expected_shape := CASE target_table_name
      WHEN 'marketplace_inventory_snapshots' THEN jsonb_build_object(
        'id', jsonb_build_array('text', 'NO', false), 'channel', jsonb_build_array('text', 'NO', false),
        'product_id', jsonb_build_array('text', 'NO', false), 'external_listing_id', jsonb_build_array('text', 'NO', false),
        'local_stock', jsonb_build_array('integer', 'NO', false), 'marketplace_stock', jsonb_build_array('integer', 'NO', false),
        'captured_at', jsonb_build_array('timestamp with time zone', 'NO', false), 'created_at', jsonb_build_array('timestamp with time zone', 'NO', true)
      )
      WHEN 'stock_sync_conflicts' THEN jsonb_build_object(
        'id', jsonb_build_array('text', 'NO', false), 'channel', jsonb_build_array('text', 'NO', false),
        'product_id', jsonb_build_array('text', 'YES', false), 'external_listing_id', jsonb_build_array('text', 'YES', false),
        'conflict_type', jsonb_build_array('text', 'NO', false), 'status', jsonb_build_array('text', 'NO', false),
        'local_stock', jsonb_build_array('integer', 'YES', false), 'marketplace_stock', jsonb_build_array('integer', 'YES', false),
        'details_snapshot', jsonb_build_array('jsonb', 'YES', false), 'resolution', jsonb_build_array('text', 'YES', false),
        'detected_at', jsonb_build_array('timestamp with time zone', 'NO', false), 'resolved_at', jsonb_build_array('timestamp with time zone', 'YES', false),
        'created_at', jsonb_build_array('timestamp with time zone', 'NO', true), 'updated_at', jsonb_build_array('timestamp with time zone', 'NO', true)
      )
      WHEN 'stock_sync_audit' THEN jsonb_build_object(
        'id', jsonb_build_array('text', 'NO', false), 'job_id', jsonb_build_array('text', 'YES', false),
        'channel', jsonb_build_array('text', 'NO', false), 'product_id', jsonb_build_array('text', 'NO', false),
        'external_listing_id', jsonb_build_array('text', 'YES', false), 'previous_marketplace_stock', jsonb_build_array('integer', 'YES', false),
        'requested_marketplace_stock', jsonb_build_array('integer', 'NO', false), 'confirmed_marketplace_stock', jsonb_build_array('integer', 'YES', false),
        'result_status', jsonb_build_array('text', 'NO', false), 'error_code', jsonb_build_array('text', 'YES', false),
        'error_message', jsonb_build_array('text', 'YES', false), 'order_id', jsonb_build_array('text', 'YES', false),
        'idempotency_key', jsonb_build_array('text', 'YES', false), 'created_at', jsonb_build_array('timestamp with time zone', 'NO', true)
      )
    END;

    IF row_count > 0 AND (
      actual_shape IS DISTINCT FROM expected_shape
      OR primary_key_count <> 1
      OR primary_key_columns IS DISTINCT FROM 'id'
    ) THEN
      RAISE EXCEPTION 'STOCK_SYNC_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION:%', target_table_name;
    END IF;
    IF row_count = 0 AND id_type <> 'text' THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id DROP DEFAULT', target_table_name);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id TYPE text USING id::text', target_table_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE marketplace_inventory_snapshots
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS external_listing_id text,
  ADD COLUMN IF NOT EXISTS local_stock integer,
  ADD COLUMN IF NOT EXISTS marketplace_stock integer,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE marketplace_inventory_snapshots ALTER COLUMN channel SET NOT NULL, ALTER COLUMN product_id SET NOT NULL, ALTER COLUMN external_listing_id SET NOT NULL, ALTER COLUMN local_stock SET NOT NULL, ALTER COLUMN marketplace_stock SET NOT NULL, ALTER COLUMN captured_at SET NOT NULL, ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE stock_sync_conflicts
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS external_listing_id text,
  ADD COLUMN IF NOT EXISTS conflict_type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS local_stock integer,
  ADD COLUMN IF NOT EXISTS marketplace_stock integer,
  ADD COLUMN IF NOT EXISTS details_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE stock_sync_conflicts ALTER COLUMN channel SET NOT NULL, ALTER COLUMN conflict_type SET NOT NULL, ALTER COLUMN status SET NOT NULL, ALTER COLUMN detected_at SET NOT NULL, ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE stock_sync_audit
  ADD COLUMN IF NOT EXISTS job_id text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS external_listing_id text,
  ADD COLUMN IF NOT EXISTS previous_marketplace_stock integer,
  ADD COLUMN IF NOT EXISTS requested_marketplace_stock integer,
  ADD COLUMN IF NOT EXISTS confirmed_marketplace_stock integer,
  ADD COLUMN IF NOT EXISTS result_status text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE stock_sync_audit ALTER COLUMN channel SET NOT NULL, ALTER COLUMN product_id SET NOT NULL, ALTER COLUMN requested_marketplace_stock SET NOT NULL, ALTER COLUMN result_status SET NOT NULL, ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_listing ON marketplace_inventory_snapshots(channel, external_listing_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_product ON marketplace_inventory_snapshots(product_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_stock_sync_conflicts_open ON stock_sync_conflicts(status, channel, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_conflicts_listing ON stock_sync_conflicts(external_listing_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_job ON stock_sync_audit(job_id);
CREATE INDEX IF NOT EXISTS idx_stock_sync_audit_listing ON stock_sync_audit(channel, external_listing_id, created_at);
