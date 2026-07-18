CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_completion_executions_sale_unique
  ON sale_completion_executions(sale_id);
