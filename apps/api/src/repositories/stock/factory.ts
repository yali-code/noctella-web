import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleStockMovementRepositories } from "./drizzle";
import type { StockMovementRepositoryBundle } from "./types";
export type StockRepositoryDriver = "sqlite" | "postgres" | "supabase-postgres";
export function createStockMovementRepositoryBundleForDb(db: unknown, driver: StockRepositoryDriver = (process.env.DATABASE_DRIVER as StockRepositoryDriver) || "sqlite"): StockMovementRepositoryBundle { if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleStockMovementRepositories(db, postgresSchema, "postgres"); return createDrizzleStockMovementRepositories(db, sqliteSchema, "sqlite"); }
