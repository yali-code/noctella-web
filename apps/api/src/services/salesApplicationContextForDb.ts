import type { DbClient } from "../db/client";
import { createSalesRepositoriesForDb } from "../repositories/sales/factory";
import type { SalesRepositoryDriver } from "../repositories/sales/types";
import {
  buildSalesApplicationContext,
  type SalesApplicationContext,
  type SalesClock,
  type SalesIdGenerator,
  type SalesLogger,
} from "./salesApplicationContext";
import { PostgresUnitOfWork, SqliteUnitOfWork, type UnitOfWork } from "./unitOfWork";
import type { SalesCompletionCoordinator } from "../application/sales/completionCoordination";

export interface CreateSalesApplicationContextForDbInput {
  readonly db: DbClient;
  readonly driver: SalesRepositoryDriver;
  readonly unitOfWork?: UnitOfWork;
  readonly logger: SalesLogger;
  readonly clock: SalesClock;
  readonly idGenerator: SalesIdGenerator;
  readonly completionCoordinator?: SalesCompletionCoordinator;
}

function unitOfWorkForDb(db: DbClient, driver: SalesRepositoryDriver): UnitOfWork {
  if (driver === "postgres" || driver === "supabase-postgres") {
    return new PostgresUnitOfWork(db as never);
  }
  return new SqliteUnitOfWork(db);
}

export function createSalesApplicationContextForDb(
  input: CreateSalesApplicationContextForDbInput,
): SalesApplicationContext {
  if (input.unitOfWork && input.unitOfWork.driver !== undefined && input.unitOfWork.driver !== input.driver) {
    throw new Error(`SALES_TRANSACTION_DRIVER_MISMATCH:${input.driver}:${input.unitOfWork.driver}`);
  }
  return buildSalesApplicationContext({
    salesRepositories: createSalesRepositoriesForDb(input.db, input.driver),
    unitOfWork: input.unitOfWork ?? unitOfWorkForDb(input.db, input.driver),
    logger: input.logger,
    clock: input.clock,
    idGenerator: input.idGenerator,
    completionCoordinator: input.completionCoordinator,
    configuration: Object.freeze({ salesApplicationContext: true as const, driver: input.driver }),
  });
}
