import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { createDatabaseRuntime } from "./runtime";
import * as schema from "./schema";

const runtime = createDatabaseRuntime();
export const db = runtime.db as ReturnType<typeof drizzle<typeof schema>>;
export const dbRuntime = runtime;
export type DbClient = typeof db;
export type SqliteDatabase = Database.Database;
