import type { DbClient } from "../../db/client";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleProductWriteRepositories } from "./drizzle";
import type { ProductWriteRepositoryBundle, SynchronousProductWriteRepository } from "./types";

export type ProductWriteRepositoryDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
export interface ProductWriteServiceContext { repositories: ProductWriteRepositoryBundle; activeProductWriteRepositoryDriver: ProductWriteRepositoryDriver; productWriteRepositoryInitialized: boolean }
const asynchronousFacade = (repository: any) => new Proxy(repository, { get(target, key) { const value = target[key]; return typeof value !== "function" ? value : (...args: any[]) => { try { return Promise.resolve(value.apply(target, args)); } catch (error) { return Promise.reject(error); } }; } });
export function createProductWriteRepositoryBundleForDb(db: DbClient, driver: ProductWriteRepositoryDriver = (process.env.DATABASE_DRIVER as ProductWriteRepositoryDriver) || "sqlite", transactionScoped = false): ProductWriteRepositoryBundle {
  if (!db) throw new Error("Product write repository client is required");
  if (driver === "sqlite") { const repositories = createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite", "synchronous"); return transactionScoped ? repositories : { ...repositories, products: asynchronousFacade(repositories.products) }; }
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleProductWriteRepositories(db, postgresSchema, "postgres");
  if (driver === "test-memory") throw new Error("Memory product write repositories are test-only and must be injected explicitly");
  throw new Error(`Unsupported product write repository driver: ${driver}`);
}
export function createSynchronousProductWriteRepositoryForDb(db: DbClient, driver: "sqlite" | "test-memory"): SynchronousProductWriteRepository {
  if (driver === "test-memory") throw new Error("Memory product write repositories are test-only and must be injected explicitly");
  return createProductWriteRepositoryBundleForDb(db, driver, true).products as unknown as SynchronousProductWriteRepository;
}
export function createProductWriteServiceContextForDb(db: DbClient, driver?: ProductWriteRepositoryDriver): ProductWriteServiceContext { const active = driver ?? ((process.env.DATABASE_DRIVER as ProductWriteRepositoryDriver) || "sqlite"); return { repositories: createProductWriteRepositoryBundleForDb(db, active), activeProductWriteRepositoryDriver: active, productWriteRepositoryInitialized: true }; }
export async function shutdownProductWriteRepositories(): Promise<void> { /* safe shutdown: injected clients are owned by caller */ }
