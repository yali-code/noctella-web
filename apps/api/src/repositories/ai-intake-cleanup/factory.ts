import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleAiIntakeCleanupRepository } from "./drizzle";
import type { AiIntakeCleanupRepository } from "./types";
import {
  createAiIntakeLockTransactionCapabilityForDb,
  type AiIntakeLockTransactionDriver,
} from "../../services/aiIntakeLockTransactionCapabilityForDb";

/** Mirrors repositories/ai-intake-photo/factory.ts's driver-resolution pattern. */
export function createAiIntakeCleanupRepository(driver?: string, db?: any): AiIntakeCleanupRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("AI intake cleanup repository requires a database client");

  const lockDriver = driver as AiIntakeLockTransactionDriver;
  const capability = createAiIntakeLockTransactionCapabilityForDb(db, lockDriver);

  if (driver === "sqlite" || driver === "test-memory") return createDrizzleAiIntakeCleanupRepository(db, sqliteSchema, capability);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleAiIntakeCleanupRepository(db, postgresSchema, capability);
  throw new Error(`Unsupported AI intake cleanup repository driver: ${driver}`);
}
