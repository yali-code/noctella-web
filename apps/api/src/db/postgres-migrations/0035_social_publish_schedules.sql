CREATE TABLE IF NOT EXISTS social_publish_schedules (
 id TEXT PRIMARY KEY NOT NULL,
 request_id TEXT NOT NULL,
 publish_intent_id TEXT NOT NULL REFERENCES social_publish_intents(id) ON DELETE RESTRICT,
 requested_publication_at TIMESTAMPTZ NOT NULL,
 requested_by_admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_publish_schedules_request_unique ON social_publish_schedules(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_publish_schedules_intent_unique ON social_publish_schedules(publish_intent_id);
