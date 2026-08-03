-- Sprint 93: AI Intake Field Review foundation. One durable current proposal per
-- AiProductIntake (enforced by the unique intake_id constraint) - not a history
-- table, not a generic AI job/execution record. No foreign key, per this
-- repository's established no-FK convention for optional cross-table pointers.
CREATE TABLE IF NOT EXISTS ai_intake_proposals (
  id text PRIMARY KEY,
  intake_id text NOT NULL UNIQUE,
  suggested_title text,
  suggested_description text,
  suggested_keywords text,
  confidence_score numeric(18, 6),
  title_decision text NOT NULL DEFAULT 'pending',
  title_value text,
  title_reviewed_by_admin_user_id text,
  title_reviewed_at timestamptz,
  description_decision text NOT NULL DEFAULT 'pending',
  description_value text,
  description_reviewed_by_admin_user_id text,
  description_reviewed_at timestamptz,
  keywords_decision text NOT NULL DEFAULT 'pending',
  keywords_value text,
  keywords_reviewed_by_admin_user_id text,
  keywords_reviewed_at timestamptz,
  photo_set_fingerprint text NOT NULL,
  generated_at timestamptz NOT NULL,
  provider_name text NOT NULL,
  prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
