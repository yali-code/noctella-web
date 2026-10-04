-- Evidence is created only by an explicit future Human Approval action.
CREATE TABLE IF NOT EXISTS social_content_approvals (
 id TEXT PRIMARY KEY NOT NULL,
 request_id TEXT NOT NULL,
 content_id TEXT NOT NULL REFERENCES social_contents(id) ON DELETE RESTRICT,
 prepared_image_id TEXT NOT NULL REFERENCES social_prepared_images(id) ON DELETE RESTRICT,
 content_version INTEGER NOT NULL,
 approved_by_admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
 approved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_content_approvals_request_unique ON social_content_approvals(request_id);
