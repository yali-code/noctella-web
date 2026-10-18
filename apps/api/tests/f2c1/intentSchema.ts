/**
 * #472 F2 Contract 1 OFFLINE PROOF ONLY. Disposable test DDL for the publication intent and the
 * trusted-parent executor exit receipt. Never registered in migrate.ts, postgres-migrations or 0042,
 * and never applied to a runtime database. photo_operations and its CHECK constraint stay untouched.
 */
export type F2c1Driver = "sqlite" | "postgres";

export function f2c1IntentDdl(driver: F2c1Driver): string[] {
  const ms = driver === "postgres" ? "BIGINT" : "INTEGER";
  return [
    `CREATE TABLE f2c1_publication_intents (
      operation_id TEXT PRIMARY KEY REFERENCES photo_operations(id),
      generation INTEGER NOT NULL,
      owner TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seal_id TEXT NOT NULL UNIQUE REFERENCES photo_operation_artifacts(id),
      main_key TEXT NOT NULL,
      thumb_key TEXT NOT NULL,
      main_sha256 TEXT NOT NULL, main_dev TEXT NOT NULL, main_ino TEXT NOT NULL,
      thumb_sha256 TEXT NOT NULL, thumb_dev TEXT NOT NULL, thumb_ino TEXT NOT NULL,
      executor_epoch INTEGER NOT NULL CHECK (executor_epoch >= 1),
      executor_token TEXT NOT NULL UNIQUE,
      executor_actor_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('authorized', 'committed', 'review')),
      created_ms ${ms} NOT NULL,
      updated_ms ${ms} NOT NULL
    )`,
    `CREATE TABLE f2c1_executor_exit_receipts (
      operation_id TEXT NOT NULL REFERENCES f2c1_publication_intents(operation_id),
      executor_epoch INTEGER NOT NULL,
      observed_by TEXT NOT NULL,
      process_handle TEXT NOT NULL,
      exit_observed_ms ${ms} NOT NULL,
      PRIMARY KEY (operation_id, executor_epoch)
    )`,
  ];
}
