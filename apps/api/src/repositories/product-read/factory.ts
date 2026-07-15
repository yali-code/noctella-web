import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleProductReadRepositories } from "./drizzle";
import type { ProductReadRepositoryBundle } from "./types";
export function createProductReadRepositories(driver?: string, db?: any): ProductReadRepositoryBundle {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("Product read repository requires a database client");
  if (driver === "sqlite") return createDrizzleProductReadRepositories(db, sqliteSchema, "sqlite");
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleProductReadRepositories(db, postgresSchema, "postgres");
  if (driver === "memory" || driver === "fake") throw new Error("Memory product read repositories are test-only and must be injected explicitly");
  throw new Error(`Unsupported product read repository driver: ${driver}`);
}
let defaultBundle: ProductReadRepositoryBundle | undefined;
export function getDefaultProductReadServiceContext() { defaultBundle ??= createProductReadRepositories(); return { repositories: defaultBundle }; }
export function createProductReadServiceContextForDb(db: any, driver: "sqlite" | "postgres" | "supabase-postgres" = "sqlite") { return { repositories: createProductReadRepositories(driver, db) }; }
export async function shutdownProductReadRepositories() { await defaultBundle?.shutdown?.(); defaultBundle = undefined; }
