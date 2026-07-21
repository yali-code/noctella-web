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
import { createInternalOrderUseCase } from "../use-cases/order/useCases";
import { createSalesApplicationContextForDb } from "./salesApplicationContextForDb";
import { enqueueProductStockSync } from "./stockSync";
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
  const createInternalSale = createInternalOrderUseCase(
    context.unitOfWork,
    { enqueue: (productId, key) => enqueueProductStockSync(db, productId, key).then(() => undefined) },
    context.clock,
    { id: () => context.idGenerator.newId() },
    driver,
  );
  return Object.freeze({
    context,
    createInternalSale,
    createSale: new CreateSaleUseCase(context),
    updateSale: new UpdateSaleUseCase(context),
    getSale: new GetSaleUseCase(context),
    listSales: new ListSalesUseCase(context),
    cancelSale: new CancelSaleUseCase(context),
  });
}
