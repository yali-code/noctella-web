-- Sprint 90: AI Product Intake foundation. A brand-new table for a new,
-- separate aggregate - no dependency on or reuse of ai_listing_drafts.
-- result_product_id is always NULL in Sprint 90 (reserved for a future
-- Sprint 94 apply transaction) and deliberately has no foreign-key
-- constraint per approved architecture, matching this repository's
-- established no-FK convention for optional cross-table pointers.
CREATE TABLE IF NOT EXISTS ai_product_intakes (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'open',
  created_by_admin_user_id text NOT NULL,
  result_product_id text UNIQUE,
  cancelled_at timestamptz,
  cancelled_by_admin_user_id text,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_product_intakes_status ON ai_product_intakes(status);
