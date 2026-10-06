-- Historical rows do not establish worker ownership. No default or backfill.
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS claim_token TEXT;
