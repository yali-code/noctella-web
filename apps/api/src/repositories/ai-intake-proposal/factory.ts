import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleAiIntakeProposalRepository } from "./drizzle";
import type { AiIntakeProposalRepository } from "./types";
import {
  createAiIntakeLockTransactionCapabilityForDb,
  type AiIntakeLockTransactionDriver,
} from "../../services/aiIntakeLockTransactionCapabilityForDb";

/** Mirrors repositories/ai-product-intake/factory.ts's driver-resolution pattern. */
export function createAiIntakeProposalRepository(driver?: string, db?: any): AiIntakeProposalRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("AI intake proposal repository requires a database client");

  const lockDriver = driver as AiIntakeLockTransactionDriver;
  const capability = createAiIntakeLockTransactionCapabilityForDb(db, lockDriver);

  if (driver === "sqlite" || driver === "test-memory") return createDrizzleAiIntakeProposalRepository(db, sqliteSchema, capability);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleAiIntakeProposalRepository(db, postgresSchema, capability);
  throw new Error(`Unsupported AI intake proposal repository driver: ${driver}`);
}
