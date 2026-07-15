import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getDatabaseConfig } from "./config";
import { ensureSchema } from "./migrate";
import * as sqliteSchema from "./schema.sqlite";
import * as postgresSchema from "./schema.postgres";

export type RuntimeDb = { driver: string; db: unknown; shutdown: () => Promise<void> };

export function createDatabaseRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeDb {
  const config = getDatabaseConfig(env);
  if (config.driver === "sqlite") {
    const sqlite = new Database(config.sqliteUrl);
    if (config.sqliteUrl !== ":memory:") sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    return { driver: "sqlite", db: drizzleSqlite(sqlite, { schema: sqliteSchema }), shutdown: async () => { sqlite.close(); } };
  }
  const connectionString = config.driver === "supabase-postgres" ? env.SUPABASE_DATABASE_URL : env.DATABASE_URL;
  if (!connectionString) throw new Error(`${config.driver} requires a configured server-side database URL`);
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: Number(env.DATABASE_POOL_TIMEOUT_MS ?? 5000), idleTimeoutMillis: Number(env.DATABASE_POOL_IDLE_TIMEOUT_MS ?? 30000), max: Number(env.DATABASE_POOL_MAX ?? 5) });
  return { driver: config.driver, db: drizzlePostgres(pool, { schema: postgresSchema }), shutdown: async () => { await pool.end(); } };
}
