-- Additive evidence only: existing schedules do not imply an execution handoff.
CREATE TABLE IF NOT EXISTS social_publish_schedule_executions (
 id TEXT PRIMARY KEY NOT NULL,
 schedule_id TEXT NOT NULL REFERENCES social_publish_schedules(id) ON DELETE RESTRICT,
 background_job_id TEXT REFERENCES background_jobs(id) ON DELETE RESTRICT,
 instagram_attempt_id TEXT REFERENCES instagram_publish_attempts(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_schedule_executions_schedule_unique ON social_publish_schedule_executions(schedule_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_schedule_executions_job_unique ON social_publish_schedule_executions(background_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_schedule_executions_attempt_unique ON social_publish_schedule_executions(instagram_attempt_id);
