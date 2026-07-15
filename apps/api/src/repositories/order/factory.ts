import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createDrizzleOrderRepositories } from "./drizzle";
import type { OrderRepositoryBundle } from "./types";
export type OrderRepositoryDriver = "sqlite"|"postgres"|"supabase-postgres"|"test-memory";
export function createOrderRepositoryBundleForDb(db:unknown, driver:OrderRepositoryDriver=(process.env.DATABASE_DRIVER as OrderRepositoryDriver)||"sqlite"):OrderRepositoryBundle{ if(!db) throw new Error("ORDER_REPOSITORY_CLIENT_REQUIRED"); if(driver==="test-memory" && process.env.NODE_ENV!=="test") throw new Error("TEST_MEMORY_ORDER_REPOSITORY_FORBIDDEN"); if(driver==="postgres"||driver==="supabase-postgres") return createDrizzleOrderRepositories(db, postgresSchema, "postgres"); if(driver==="sqlite"||driver==="test-memory") return createDrizzleOrderRepositories(db, sqliteSchema, "sqlite"); throw new Error(`UNSUPPORTED_ORDER_REPOSITORY_DRIVER:${driver}`); }
