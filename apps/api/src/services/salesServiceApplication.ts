import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import {
  CancelSaleUseCase,
  CreateSaleUseCase,
  GetSaleUseCase,
  ListSalesUseCase,
  UpdateSaleUseCase,
} from "../application/sales";
import type { SalesRepositoryDriver } from "../repositories/sales/types";
import { createSalesApplicationContextForDb } from "./salesApplicationContextForDb";
import type { SalesClock, SalesIdGenerator, SalesLogger } from "./salesApplicationContext";

export interface SalesServiceApplicationDependencies {
  readonly driver?: SalesRepositoryDriver;
  readonly logger?: SalesLogger;
  readonly clock?: SalesClock;
  readonly idGenerator?: SalesIdGenerator;
}

export function createSalesServiceApplication(db: DbClient, dependencies: SalesServiceApplicationDependencies = {}) {
  const driver = dependencies.driver ?? (process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? process.env.DATABASE_DRIVER : "sqlite");
  const context = createSalesApplicationContextForDb({
    db,
    driver,
    logger: dependencies.logger ?? {},
    clock: dependencies.clock ?? { now: () => new Date() },
    idGenerator: dependencies.idGenerator ?? { newId: () => randomUUID() },
  });
  return Object.freeze({
    context,
    createSale: new CreateSaleUseCase(context),
    updateSale: new UpdateSaleUseCase(context),
    getSale: new GetSaleUseCase(context),
    listSales: new ListSalesUseCase(context),
    cancelSale: new CancelSaleUseCase(context),
  });
}
