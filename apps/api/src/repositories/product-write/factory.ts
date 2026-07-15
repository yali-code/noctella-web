import type { DbClient } from "../../db/client";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleProductWriteRepositories } from "./drizzle";
import type { ProductWriteRepositoryBundle } from "./types";

export type ProductWriteRepositoryDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
export interface ProductWriteServiceContext { repositories: ProductWriteRepositoryBundle; activeProductWriteRepositoryDriver: ProductWriteRepositoryDriver; productWriteRepositoryInitialized: boolean }
export function createProductWriteRepositoryBundleForDb(db: DbClient, driver: ProductWriteRepositoryDriver = (process.env.DATABASE_DRIVER as ProductWriteRepositoryDriver) || "sqlite"): ProductWriteRepositoryBundle {
  if (!db) throw new Error("Product write repository client is required");
  if (driver === "sqlite") return createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite");
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleProductWriteRepositories(db, postgresSchema, "postgres");
  if (driver === "test-memory") throw new Error("Memory product write repositories are test-only and must be injected explicitly");
  throw new Error(`Unsupported product write repository driver: ${driver}`);
}
export function createProductWriteServiceContextForDb(db: DbClient, driver?: ProductWriteRepositoryDriver): ProductWriteServiceContext { const active = driver ?? ((process.env.DATABASE_DRIVER as ProductWriteRepositoryDriver) || "sqlite"); return { repositories: createProductWriteRepositoryBundleForDb(db, active), activeProductWriteRepositoryDriver: active, productWriteRepositoryInitialized: true }; }
export async function shutdownProductWriteRepositories(): Promise<void> { /* safe shutdown: injected clients are owned by caller */ }
