DO $$
DECLARE
  existing_rows bigint;
  target_columns integer;
  id_type text;
BEGIN
  IF to_regclass('background_jobs') IS NOT NULL THEN
    SELECT count(*) INTO existing_rows FROM background_jobs;
    SELECT count(*) INTO target_columns
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'background_jobs'
        AND column_name = ANY (ARRAY['id','type','status','channel','product_id','external_listing_id','payload_snapshot','idempotency_key','priority','attempt_count','max_attempts','run_after','locked_at','locked_by','last_error','created_at','updated_at','completed_at']);
    SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
      FROM pg_attribute a
      WHERE a.attrelid = 'background_jobs'::regclass AND a.attname = 'id' AND NOT a.attisdropped;

    IF existing_rows > 0 AND (target_columns < 18 OR id_type <> 'text') THEN
      RAISE EXCEPTION 'BACKGROUND_JOBS_INCOMPLETE_LEGACY_ROWS_REQUIRE_MANUAL_RECONCILIATION';
    END IF;

    IF id_type <> 'text' THEN
      ALTER TABLE background_jobs ALTER COLUMN id DROP DEFAULT;
      ALTER TABLE background_jobs ALTER COLUMN id TYPE text USING id::text;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS background_jobs (
  id text PRIMARY KEY NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  channel text,
  product_id text,
  external_listing_id text,
  payload_snapshot jsonb NOT NULL,
  idempotency_key text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE background_jobs
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS external_listing_id text,
  ADD COLUMN IF NOT EXISTS payload_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS priority integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS run_after timestamptz,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE background_jobs
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN payload_snapshot SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN priority SET DEFAULT 0,
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN attempt_count SET DEFAULT 0,
  ALTER COLUMN attempt_count SET NOT NULL,
  ALTER COLUMN max_attempts SET DEFAULT 5,
  ALTER COLUMN max_attempts SET NOT NULL,
  ALTER COLUMN run_after SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_idempotency ON background_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_background_jobs_status_run ON background_jobs(status, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_background_jobs_type ON background_jobs(type);
CREATE INDEX IF NOT EXISTS idx_background_jobs_channel ON background_jobs(channel);
CREATE INDEX IF NOT EXISTS idx_background_jobs_product ON background_jobs(product_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_external_listing ON background_jobs(external_listing_id);
