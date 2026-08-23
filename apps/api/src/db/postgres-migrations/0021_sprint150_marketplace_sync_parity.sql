CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_channel_external
  ON marketplace_webhook_events (channel, external_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_channel_external
  ON marketplace_orders (channel, external_order_id);
