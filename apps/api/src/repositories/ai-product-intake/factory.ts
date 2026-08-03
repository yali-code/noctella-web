import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleAiProductIntakeRepository } from "./drizzle";
import type { AiProductIntakeRepository } from "./types";

/** Mirrors repositories/product-read/factory.ts's driver-resolution pattern. */
export function createAiProductIntakeRepository(driver?: string, db?: any): AiProductIntakeRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("AI product intake repository requires a database client");
  if (driver === "sqlite" || driver === "test-memory") return createDrizzleAiProductIntakeRepository(db, sqliteSchema);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleAiProductIntakeRepository(db, postgresSchema);
  throw new Error(`Unsupported AI product intake repository driver: ${driver}`);
}
