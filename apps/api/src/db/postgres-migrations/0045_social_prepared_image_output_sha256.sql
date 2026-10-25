-- P5 (#472 parity 4B, option B): sha256 of the protected-mode Instagram derivative in the separate store.
-- Additive and nullable only; no backfill. Rows without it (legacy) are never trusted in protected mode.
ALTER TABLE social_prepared_images ADD COLUMN IF NOT EXISTS output_sha256 TEXT;
