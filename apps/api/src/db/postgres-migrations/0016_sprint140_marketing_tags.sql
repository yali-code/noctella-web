-- Sprint 140: normalized Product Marketing Tag taxonomy. Additive only. Two new,
-- narrowly-scoped tables - distinct from Product Category, Collections, SEO keywords, and Etsy
-- listing tags. No FK constraint, matching this schema's established convention (e.g.
-- ai_product_intakes.result_product_id).
CREATE TABLE IF NOT EXISTS marketing_tags (
  id text PRIMARY KEY,
  key text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_tags_key_unique ON marketing_tags(key);

CREATE TABLE IF NOT EXISTS product_marketing_tags (
  id text PRIMARY KEY,
  product_id text NOT NULL,
  marketing_tag_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_marketing_tags_unique ON product_marketing_tags(product_id, marketing_tag_id);
