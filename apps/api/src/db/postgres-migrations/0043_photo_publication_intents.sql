-- Stage 5 F2 WP1 (#472): durable publication intent and executor exit records. Additive, forward-only; no
-- owner, route or flag wiring. 0039 (Etsy) and 0042 (W11 proposal) stay reserved and are not used here.
-- An intent is NON-EXPIRING publication authority for exactly one operation generation and seal; while it is
-- 'authorized' a guarded reclaim must refuse to supersede the generation. Exit records are persisted only by a
-- trusted component that has itself authenticated executor exit; this schema does not authenticate anything.
CREATE TABLE IF NOT EXISTS photo_publication_intents (
  operation_id TEXT PRIMARY KEY REFERENCES photo_operations(id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 1 AND 128),
  seal_id TEXT NOT NULL UNIQUE REFERENCES photo_operation_artifacts(id),
  main_key TEXT NOT NULL CHECK (length(main_key) BETWEEN 1 AND 512),
  thumb_key TEXT NOT NULL CHECK (length(thumb_key) BETWEEN 1 AND 512),
  main_sha256 TEXT NOT NULL CHECK (length(main_sha256) = 64),
  main_dev TEXT NOT NULL,
  main_ino TEXT NOT NULL,
  thumb_sha256 TEXT NOT NULL CHECK (length(thumb_sha256) = 64),
  thumb_dev TEXT NOT NULL,
  thumb_ino TEXT NOT NULL,
  executor_epoch BIGINT NOT NULL CHECK (executor_epoch >= 1),
  executor_token TEXT NOT NULL UNIQUE CHECK (length(executor_token) BETWEEN 1 AND 256),
  executor_identity TEXT NOT NULL CHECK (length(executor_identity) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('authorized', 'committed', 'review')),
  created_ms BIGINT NOT NULL CHECK (created_ms >= 0),
  updated_ms BIGINT NOT NULL CHECK (updated_ms >= 0)
);
CREATE TABLE IF NOT EXISTS photo_executor_exit_records (
  operation_id TEXT NOT NULL REFERENCES photo_publication_intents(operation_id),
  executor_epoch BIGINT NOT NULL CHECK (executor_epoch >= 1),
  executor_identity TEXT NOT NULL CHECK (length(executor_identity) BETWEEN 1 AND 256),
  attested_by TEXT NOT NULL CHECK (length(attested_by) BETWEEN 1 AND 256),
  exit_observed_ms BIGINT NOT NULL CHECK (exit_observed_ms >= 0),
  PRIMARY KEY (operation_id, executor_epoch)
);
