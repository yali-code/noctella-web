ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_paused_at timestamptz;

CREATE TABLE IF NOT EXISTS product_lifecycle_operations (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('pause', 'relist')),
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'partially_failed', 'failed')),
  reason text,
  previous_product_status text NOT NULL,
  target_snapshot jsonb NOT NULL,
  target_results jsonb NOT NULL,
  actor_admin_user_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_product_lifecycle_product ON product_lifecycle_operations(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_lifecycle_one_processing ON product_lifecycle_operations(product_id) WHERE status = 'processing';
