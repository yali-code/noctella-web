-- Sprint 107: Stock AI -> Marketplace Publish Preparation. Additive only.
-- One new, narrowly-scoped table: the in-flight, unapproved AI
-- marketplace-preparation proposal, one row per (product_id, channel).
-- Never the destination of approved content itself - approval copies
-- admin-reviewed values onto the existing products.<channel>* columns
-- (unchanged, see products table). Does not modify or repurpose
-- ai_listing_drafts, ai_intake_proposals, publish_jobs, publish_attempts, or
-- external_listings.
CREATE TABLE IF NOT EXISTS marketplace_preparations (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  base_product_updated_at timestamptz NOT NULL,
  suggested_title text,
  suggested_description text,
  suggested_condition_description text,
  suggested_item_specifics text,
  suggested_tags text,
  suggested_materials text,
  suggested_style text,
  suggested_occasion text,
  suggested_short_description text,
  suggested_seo_title text,
  suggested_meta_description text,
  suggested_focus_keyword text,
  provider_name text NOT NULL,
  prompt_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  applied_at timestamptz,
  applied_by_admin_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_preparations_product_channel ON marketplace_preparations(product_id, channel);
