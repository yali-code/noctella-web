-- Sprint 89: additive migration for the AI Draft generation-baseline column.
-- ai_listing_drafts already exists (0001_sprint24_foundation.sql). This adds the
-- durable Product.updated_at value captured at generation time, used as
-- expectedUpdatedAt for the canonical Product update at approval. Nullable,
-- never backfilled - existing rows remain NULL and must be regenerated before
-- they can be approved. Same column type as products.updated_at (timestamp
-- with time zone) so a value copied directly from it round-trips exactly.
ALTER TABLE ai_listing_drafts ADD COLUMN IF NOT EXISTS base_product_updated_at TIMESTAMPTZ;
