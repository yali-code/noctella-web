-- Sprint 30A1 Return repository foundation parity. Additive only; no destructive DDL.
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS external_reference TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS quantity_completed INTEGER;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS inspection_result JSONB;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE return_events ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE return_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_requests_idempotency ON return_requests(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_events_idempotency ON return_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_return_items_product ON return_items(product_id);
