-- P2-2B3D5 (#396/#403/#407) PROPOSED durable photo-operation ownership schema.
-- NOT REGISTERED: this file is outside apps/api/src/db (SQLite ensureSchema) and
-- apps/api/src/db/postgres-migrations, so no application path applies it.
-- Portable SQL, applied verbatim to disposable SQLite and PostgreSQL test databases only.
-- Additive: no existing table, column, key, URL or row is changed.

-- Physical storage-root identity, registered once per (private, canonical) root pair.
CREATE TABLE IF NOT EXISTS photo_storage_roots (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  created_ms BIGINT NOT NULL
);

-- One row per logical photo write. Identity and canonical binding are immutable after insert.
CREATE TABLE IF NOT EXISTS photo_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ai_finalize', 'product_upload')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  target_photo_id TEXT NOT NULL,
  main_key TEXT NOT NULL UNIQUE,
  thumb_key TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  owner TEXT NOT NULL,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'sealed', 'committed', 'review')),
  lease_until_ms BIGINT NOT NULL,
  seal_id TEXT,
  committed_photo_id TEXT,
  committed_event_id TEXT,
  review_reason TEXT,
  created_ms BIGINT NOT NULL,
  updated_ms BIGINT NOT NULL,
  UNIQUE (subject_type, subject_id),
  UNIQUE (target_photo_id),
  CHECK (main_key <> thumb_key)
);

-- Append-only generation history; a nonce can never be reused within an operation (ABA).
CREATE TABLE IF NOT EXISTS photo_operation_generations (
  operation_id TEXT NOT NULL REFERENCES photo_operations(id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  owner TEXT NOT NULL,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'committed', 'review')),
  created_ms BIGINT NOT NULL,
  updated_ms BIGINT NOT NULL,
  PRIMARY KEY (operation_id, generation),
  UNIQUE (operation_id, nonce)
);

-- Sealed private artifacts (exact inode identity as decimal strings; sizes for retained accounting).
CREATE TABLE IF NOT EXISTS photo_operation_artifacts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  main_sha256 TEXT NOT NULL,
  thumb_sha256 TEXT NOT NULL,
  main_bytes BIGINT NOT NULL CHECK (main_bytes > 0),
  thumb_bytes BIGINT NOT NULL CHECK (thumb_bytes > 0),
  main_dev TEXT NOT NULL,
  main_ino TEXT NOT NULL,
  thumb_dev TEXT NOT NULL,
  thumb_ino TEXT NOT NULL,
  created_ms BIGINT NOT NULL,
  FOREIGN KEY (operation_id, generation) REFERENCES photo_operation_generations(operation_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_photo_operations_state ON photo_operations(state);
CREATE INDEX IF NOT EXISTS idx_photo_operation_artifacts_operation ON photo_operation_artifacts(operation_id, generation);
