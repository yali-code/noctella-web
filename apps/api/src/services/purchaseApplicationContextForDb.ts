import crypto from "node:crypto";
import type { DbClient } from "../db/client";
import { createPurchaseRepositoriesForDb } from "../repositories/purchase/factory";
import type { PurchaseEventPublisher } from "../events/purchase";
import type { PurchaseObservability } from "../observability/purchase";
import type { PurchaseRepositoryDriver } from "../repositories/purchase/types";
import {
  buildPurchaseApplicationContext,
  type PurchaseApplicationContext,
  type PurchaseLogger,
} from "./purchaseApplicationContext";
import { PostgresUnitOfWork, SqliteUnitOfWork, type UnitOfWork } from "./unitOfWork";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { increaseInventoryInTransactionUseCase } from "../application/inventory";

export interface CreatePurchaseApplicationContextForDbInput {
  readonly db: DbClient;
  readonly driver?: PurchaseRepositoryDriver;
  readonly unitOfWork?: UnitOfWork;
  readonly logger?: PurchaseLogger;
  readonly eventPublisher?: PurchaseEventPublisher;
  readonly observability?: PurchaseObservability;
}

function unitOfWorkForDb(db: DbClient, driver: PurchaseRepositoryDriver): UnitOfWork {
  if (driver === "postgres" || driver === "supabase-postgres") {
    return new PostgresUnitOfWork(db as never);
  }
  return new SqliteUnitOfWork(db);
}

export function createPurchaseApplicationContextForDb(
  input: DbClient | CreatePurchaseApplicationContextForDbInput,
): PurchaseApplicationContext {
  const options = "db" in (input as CreatePurchaseApplicationContextForDbInput)
    ? (input as CreatePurchaseApplicationContextForDbInput)
    : { db: input as DbClient };
  const driver = options.driver ?? "sqlite";
  if (options.unitOfWork && options.unitOfWork.driver !== undefined && options.unitOfWork.driver !== driver) {
    throw new Error(`PURCHASE_TRANSACTION_DRIVER_MISMATCH:${driver}:${options.unitOfWork.driver}`);
  }
  return buildPurchaseApplicationContext({
    purchaseRepositories: createPurchaseRepositoriesForDb(options.db, driver),
    unitOfWork: options.unitOfWork ?? unitOfWorkForDb(options.db, driver),
    inventoryReceiptMutation: (db, inventoryContext, mutation) =>
      increaseInventoryInTransactionUseCase(
        inventoryContext,
        createInventoryRepositoryBundleForDb(
          db,
          driver,
          driver === "sqlite",
        ),
        mutation,
      ),
    logger: options.logger ?? {},
    clock: { now: () => new Date() },
    idGenerator: { newId: () => crypto.randomUUID() },
    eventPublisher: options.eventPublisher,
    observability: options.observability,
    configuration: Object.freeze({ purchaseApplicationContext: true as const, driver }),
  });
}
