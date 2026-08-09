ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_transaction_reference TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expected_amount_cents INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_snapshot JSONB;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM payments WHERE provider_reference IS NOT NULL GROUP BY provider, provider_reference HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_REFERENCE_CONFLICT';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE provider_transaction_reference IS NOT NULL GROUP BY provider, provider_transaction_reference HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_TRANSACTION_REFERENCE_CONFLICT';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_payments_provider_reference;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference_unique ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_transaction_unique ON payments(provider, provider_transaction_reference) WHERE provider_transaction_reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, event_type TEXT NOT NULL, payment_id TEXT, status TEXT NOT NULL, result_classification TEXT, error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_event_unique ON payment_events(provider, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events(payment_id);
