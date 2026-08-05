-- Sprint 95: AI Intake photo promotion, Primary selection, and finalization.
-- Additive only - adds the audit columns needed for the new Finalized terminal
-- status (a TypeScript-only enum value, "finalized", added to the existing
-- ai_product_intakes.status text column - no schema change required for the
-- status value itself). No new table, no FK, per this repository's
-- established no-FK convention for optional cross-table pointers.
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS finalized_by_admin_user_id text;
