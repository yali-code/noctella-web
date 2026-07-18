CREATE TABLE IF NOT EXISTS sale_completion_executions (
  idempotency_key TEXT PRIMARY KEY,
  payload_fingerprint TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  result_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_completion_executions_sale ON sale_completion_executions(sale_id);
