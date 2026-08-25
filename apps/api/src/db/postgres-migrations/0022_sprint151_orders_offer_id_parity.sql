ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS offer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_offer
  ON orders (offer_id);
