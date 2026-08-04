-- Sprint 94: AI Intake explicit Save as Draft canonical apply transaction.
-- Additive only - adds the audit columns needed for the new Applied terminal
-- status (a TypeScript-only enum value, "applied", added to the existing
-- ai_product_intakes.status text column - no schema change required for the
-- status value itself). No new table, no FK, per this repository's
-- established no-FK convention for optional cross-table pointers.
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS applied_by_admin_user_id text;
