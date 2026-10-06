-- No default or backfill: historical attempts do not prove safe provider entry.
ALTER TABLE instagram_publish_attempts
  ADD COLUMN IF NOT EXISTS provider_entry_state TEXT
  CHECK (provider_entry_state IN ('unclaimed', 'claimed'));
