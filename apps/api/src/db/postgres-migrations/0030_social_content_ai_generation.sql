-- Nullable editorial fields and immutable generation provenance; no backfill.
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS hashtags TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS concept TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_provider TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_model TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_prompt_version TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMPTZ;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_request_id TEXT;
ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ai_source_product_id TEXT;
ALTER TABLE social_content_media ADD COLUMN IF NOT EXISTS editorial_alt_text TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_contents_ai_request_unique ON social_contents(ai_request_id);
