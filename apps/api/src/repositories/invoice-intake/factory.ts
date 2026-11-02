import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleInvoiceIntakeRepository } from "./drizzle";
import type { InvoiceIntakeRepository } from "./types";

/** Mirrors repositories/ai-product-intake/factory.ts's driver-resolution pattern. */
export function createInvoiceIntakeRepository(driver?: string, db?: any): InvoiceIntakeRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("Invoice intake repository requires a database client");
  if (driver === "sqlite" || driver === "test-memory") return createDrizzleInvoiceIntakeRepository(db, sqliteSchema);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleInvoiceIntakeRepository(db, postgresSchema);
  throw new Error(`Unsupported invoice intake repository driver: ${driver}`);
}
