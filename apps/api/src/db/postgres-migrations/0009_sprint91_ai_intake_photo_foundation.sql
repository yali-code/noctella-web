-- Sprint 91: AI Intake Photo foundation. A separate, minimal, private staged-photo
-- concept for AiProductIntake - fully independent of ProductPhoto (no shared table,
-- no shared storage lifecycle, no promotion logic). No foreign key, per this
-- repository's established no-FK convention for optional cross-table pointers.
CREATE TABLE IF NOT EXISTS ai_intake_photos (
  id text PRIMARY KEY,
  intake_id text NOT NULL,
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  created_by_admin_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_intake_photos_intake ON ai_intake_photos(intake_id);
