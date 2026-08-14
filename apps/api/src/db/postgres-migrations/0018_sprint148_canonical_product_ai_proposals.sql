-- Sprint 148: Canonical Product & Physical AI Suggestions. Additive only.
-- One new, narrowly-scoped table: the in-flight, unapproved canonical Product AI proposal, one
-- row per product_id (never per channel - deliberately NOT marketplace_preparations with a fake
-- channel; see Sprint 148 Architecture Review Option B). Never the destination of approved
-- content itself - Accept copies admin-SELECTED suggested values onto the existing Product
-- columns and additively onto Marketing Tags (unchanged tables). Does not modify or repurpose
-- marketplace_preparations, ai_intake_proposals, ai_listing_drafts, marketing_tags, or
-- product_marketing_tags.
CREATE TABLE IF NOT EXISTS canonical_product_ai_proposals (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  base_product_updated_at timestamptz NOT NULL,
  suggested_brand text,
  suggested_model text,
  suggested_manufacturer text,
  suggested_country_of_origin text,
  suggested_period text,
  suggested_materials text,
  suggested_description text,
  suggested_product_story text,
  suggested_condition text,
  suggested_condition_description text,
  suggested_length_value numeric(18,6),
  suggested_width_value numeric(18,6),
  suggested_height_value numeric(18,6),
  suggested_dimension_unit text,
  suggested_weight_value numeric(18,6),
  suggested_weight_unit text,
  suggested_marketing_tags text,
  provider_name text NOT NULL,
  prompt_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  applied_at timestamptz,
  applied_by_admin_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_product_ai_proposals_product ON canonical_product_ai_proposals(product_id);
