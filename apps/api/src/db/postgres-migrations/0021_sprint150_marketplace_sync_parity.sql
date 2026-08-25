DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'marketplace_order_items'
      AND column_name = 'title_snapshot'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE marketplace_order_items
      ALTER COLUMN title_snapshot TYPE text
      USING CASE
        WHEN jsonb_typeof(title_snapshot) = 'string' THEN title_snapshot #>> '{}'
        ELSE title_snapshot::text
      END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_channel_external
  ON marketplace_webhook_events (channel, external_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_channel_external
  ON marketplace_orders (channel, external_order_id);
