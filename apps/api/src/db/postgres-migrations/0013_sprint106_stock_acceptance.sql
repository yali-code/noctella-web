-- Sprint 106: AI Intake -> Stock Acceptance -> Publish. Additive only.
-- 1) Expanded AI Full Product Analysis suggestion fields - direct, single-value
--    suggestions (not tracked with the per-field Accept/Edit/Reject/Pending
--    decision columns title/description/keywords already use, since these are
--    discrete values reviewed/edited as a whole at Stock Acceptance time, not
--    long-form text needing word-level review).
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_category_id text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_brand text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_model text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_manufacturer text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_country_of_origin text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_period text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_materials text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_condition text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_condition_description text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_seo_title text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_meta_description text;
ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_price_eur numeric(18,6);

-- 2) System-generated Product SKU sequence - a single persisted counter row,
--    allocated and incremented inside the same transaction as canonical
--    Product creation (see repositories/product-write/drizzle.ts's
--    allocateNextProductSkuInTransaction). Narrowly scoped to this one
--    purpose - not a generic sequence facility.
CREATE TABLE IF NOT EXISTS product_sku_sequence (
  id text PRIMARY KEY,
  next_value integer NOT NULL
);
