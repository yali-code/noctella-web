CREATE TABLE IF NOT EXISTS instagram_publish_attempts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES marketplace_connections(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  caption TEXT NOT NULL,
  media_url TEXT NOT NULL,
  container_id TEXT,
  published_media_id TEXT,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_instagram_attempts_connection ON instagram_publish_attempts(connection_id, created_at);
