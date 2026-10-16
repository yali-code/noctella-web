-- Stage 5 #424 / Draft only. Additive W2 idempotency intent binding; no live writer adoption.
-- 0040 is immutable: do not backfill or rewrite existing photo operations.
-- Token is globally unique so cross-tenant token reuse MUST conflict, not duplicate.
-- Claim with INSERT ... ON CONFLICT DO NOTHING, then SELECT and compare the
-- entire immutable intent under an appropriately scoped transaction.
-- operation_id may be bound only with a generation-fenced operation claim;
-- this schema alone does NOT give exactly-once photo/outbox commit.
CREATE TABLE IF NOT EXISTS photo_w2_upload_intents (
  token TEXT PRIMARY KEY CHECK (length(token) BETWEEN 16 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 128),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  alt_text TEXT NOT NULL CHECK (length(alt_text) <= 500),
  operation_id TEXT UNIQUE REFERENCES photo_operations(id),
  created_ms BIGINT NOT NULL CHECK (created_ms >= 0),
  CHECK (operation_id IS NULL OR operation_id <> '')
);
CREATE INDEX IF NOT EXISTS idx_photo_w2_upload_intents_product ON photo_w2_upload_intents(tenant_id, product_id);
