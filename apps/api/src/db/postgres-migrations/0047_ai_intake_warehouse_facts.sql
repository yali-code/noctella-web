-- Warehouse-declared facts captured on an intake before AI generation.
-- Additive and nullable only; no backfill. NULL means never declared.
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS declared_condition TEXT;
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS test_note TEXT;
