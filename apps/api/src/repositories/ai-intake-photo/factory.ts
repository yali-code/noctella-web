import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleAiIntakePhotoRepository } from "./drizzle";
import type { AiIntakePhotoRepository } from "./types";

/** Mirrors repositories/ai-product-intake/factory.ts's driver-resolution pattern. */
export function createAiIntakePhotoRepository(driver?: string, db?: any): AiIntakePhotoRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("AI intake photo repository requires a database client");
  if (driver === "sqlite" || driver === "test-memory") return createDrizzleAiIntakePhotoRepository(db, sqliteSchema);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleAiIntakePhotoRepository(db, postgresSchema);
  throw new Error(`Unsupported AI intake photo repository driver: ${driver}`);
}
