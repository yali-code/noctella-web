import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema.postgres";

const MARKER = /(^|[-_])(test|disposable)([-_]|$)/i;
const FORBIDDEN = /(^|[-_])(prod|production|stage|staging)([-_]|$)/i;

export function assertDisposablePostgresUrl(raw: string | undefined): string {
  if (!raw) throw new Error("POSTGRES_TEST_DATABASE_URL_REQUIRED");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("POSTGRES_TEST_DATABASE_URL_INVALID"); }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("POSTGRES_TEST_DATABASE_URL_INVALID_PROTOCOL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || !MARKER.test(database) || FORBIDDEN.test(database) || /^(noctella|postgres)$/i.test(database)) {
    throw new Error("POSTGRES_TEST_DATABASE_NOT_EXPLICITLY_DISPOSABLE");
  }
  return raw;
}

function migrationFiles(through: string) {
  const directory = path.resolve(__dirname, "../src/db/postgres-migrations");
  const files = fs.readdirSync(directory).filter((file) => file.endsWith(".sql") && file.localeCompare(through) <= 0).sort();
  if (!files.some((file) => file.startsWith("0021_")) && through.startsWith("0021_")) throw new Error("POSTGRES_MIGRATION_0021_MISSING");
  return files.map((file) => ({ file, sql: fs.readFileSync(path.join(directory, file), "utf8") }));
}

export async function applyPostgresMigrations(client: pg.PoolClient, schemaName: string, through = "0022_sprint151_orders_offer_id_parity.sql") {
  const applied: string[] = [];
  let currentMigration: string | undefined;
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('search_path', $1, true)", [schemaName]);
    const effective = await client.query<{ currentSchema: string | null }>("SELECT current_schema() AS \"currentSchema\"");
    if (effective.rows[0]?.currentSchema !== schemaName) throw new Error("POSTGRES_TEST_SCHEMA_TARGET_MISMATCH");
    for (const migration of migrationFiles(through)) { currentMigration = migration.file; await client.query(migration.sql); applied.push(migration.file); }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    if (!currentMigration) throw error;
    const failure = new Error(`POSTGRES_MIGRATION_FAILED:${currentMigration}`, { cause: error });
    if (error && typeof error === "object") {
      for (const key of ["code", "detail", "hint", "position", "schema", "table", "constraint"] as const) {
        if (key in error) (failure as unknown as Record<string, unknown>)[key] = (error as Record<string, unknown>)[key];
      }
    }
    throw failure;
  }
}

export interface PostgresTestDb {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  schemaName: string;
  migrateAgain(): Promise<string[]>;
  close(): Promise<void>;
}

export async function createPostgresTestDb(through = "0022_sprint151_orders_offer_id_parity.sql"): Promise<PostgresTestDb> {
  const connectionString = assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL);
  const schemaName = `sprint151_test_${crypto.randomBytes(8).toString("hex")}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await admin.end();
  const pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schemaName}` });
  const client = await pool.connect();
  try { await applyPostgresMigrations(client, schemaName, through); } catch (error) { client.release(); await pool.end(); const cleanup = new pg.Pool({ connectionString, max: 1 }); await cleanup.query(`DROP SCHEMA "${schemaName}" CASCADE`); await cleanup.end(); throw error; }
  client.release();
  return {
    db: drizzle(pool, { schema }), pool, schemaName,
    async migrateAgain() { const next = await pool.connect(); try { return await applyPostgresMigrations(next, schemaName, through); } finally { next.release(); } },
    async close() { await pool.end(); const cleanup = new pg.Pool({ connectionString, max: 1 }); try { await cleanup.query(`DROP SCHEMA "${schemaName}" CASCADE`); } finally { await cleanup.end(); } },
  };
}

export const postgresTestConfigured = Boolean(process.env.POSTGRES_TEST_DATABASE_URL);
