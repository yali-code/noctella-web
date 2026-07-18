import type { SalesRepositoryDriver } from "../sales/types";
import type { SalesCompletionTransactionRepository } from "./types";
import { createSqliteSalesCompletionTransactionRepository } from "./sqlite";
import { createPostgresSalesCompletionTransactionRepository } from "./postgres";
export function createSalesCompletionTransactionRepositoryForDb(db: unknown, driver: SalesRepositoryDriver): SalesCompletionTransactionRepository {
  return driver === "postgres" || driver === "supabase-postgres" ? createPostgresSalesCompletionTransactionRepository(db) : createSqliteSalesCompletionTransactionRepository(db);
}
