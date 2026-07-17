import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import { createSqliteRefundRepositories } from "./sqlite";
import { createPostgresRefundRepositories } from "./postgres";
import type { RefundRepositories, RefundRepositoryDriver } from "./types";
export function createRefundRepositoriesForDb(db:unknown, driver:RefundRepositoryDriver=(process.env.DATABASE_DRIVER as RefundRepositoryDriver)||"sqlite"):RefundRepositories{ if(!db) throw new Error("REFUND_REPOSITORY_CLIENT_REQUIRED"); if(driver==="postgres"||driver==="supabase-postgres") return createPostgresRefundRepositories(db); if(driver==="sqlite"||driver==="test-memory") return createSqliteRefundRepositories(db as any, sqliteSchema); throw new Error(`UNSUPPORTED_REFUND_REPOSITORY_DRIVER:${driver}`); }
export { sqliteSchema, postgresSchema };
