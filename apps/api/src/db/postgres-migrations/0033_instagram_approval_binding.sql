ALTER TABLE instagram_publish_attempts
  ADD COLUMN approval_id TEXT REFERENCES social_content_approvals(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_instagram_attempts_approval_unique
  ON instagram_publish_attempts(approval_id);
