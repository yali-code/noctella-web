-- Stage 5 F2 (#472) WP2: durable identity of each publisher-owned verified copy. Additive, forward-only.
-- One row per (operation, artifact): the staging inode the CURRENT intent executor created, verified against the
-- seal and recorded BEFORE it is linked to the canonical name. Recovery adopts a canonical name only when it is
-- exactly this recorded inode with the sealed bytes; anything else is a collision and goes to review.
CREATE TABLE IF NOT EXISTS photo_publication_copies (
  operation_id TEXT NOT NULL REFERENCES photo_publication_intents(operation_id),
  artifact TEXT NOT NULL CHECK (artifact IN ('main', 'thumb')),
  executor_epoch BIGINT NOT NULL CHECK (executor_epoch >= 1),
  staging_name TEXT NOT NULL CHECK (length(staging_name) BETWEEN 1 AND 128),
  copy_dev TEXT NOT NULL CHECK (length(copy_dev) BETWEEN 1 AND 64),
  copy_ino TEXT NOT NULL CHECK (length(copy_ino) BETWEEN 1 AND 64),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  recorded_ms BIGINT NOT NULL CHECK (recorded_ms >= 0),
  PRIMARY KEY (operation_id, artifact)
);
