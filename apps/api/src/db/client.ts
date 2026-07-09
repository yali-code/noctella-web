import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "./migrate";
import * as schema from "./schema";

/**
 * DATABASE_URL is expected as a plain filesystem path for SQLite, e.g.
 * "./data/dev.sqlite" or ":memory:" for tests. Defaults to a local dev file
 * so the API works out of the box without extra setup.
 */
const databaseUrl = process.env.DATABASE_URL ?? "./data/dev.sqlite";

const sqlite = new Database(databaseUrl);
if (databaseUrl !== ":memory:") {
  sqlite.pragma("journal_mode = WAL");
}
sqlite.pragma("foreign_keys = ON");
ensureSchema(sqlite);

export const db = drizzle(sqlite, { schema });
export type DbClient = typeof db;
