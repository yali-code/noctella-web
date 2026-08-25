ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_method_id text,
  ADD COLUMN IF NOT EXISTS shipping_method_label text;
