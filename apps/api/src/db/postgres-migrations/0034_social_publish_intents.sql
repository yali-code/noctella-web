CREATE TABLE IF NOT EXISTS social_publish_intents (
 id TEXT PRIMARY KEY NOT NULL,
 request_id TEXT NOT NULL,
 approval_id TEXT NOT NULL REFERENCES social_content_approvals(id) ON DELETE RESTRICT,
 requested_by_admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_publish_intents_request_unique ON social_publish_intents(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_publish_intents_approval_unique ON social_publish_intents(approval_id);
