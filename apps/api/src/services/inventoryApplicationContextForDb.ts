import crypto from "node:crypto";
import type { DbClient } from "../db/client";
import { createInventoryRepositoryBundleForDb, type InventoryRepositoryDriver } from "../repositories/inventory/factory";
import type { InventoryTransactionContext, PassThroughInventoryUnitOfWork } from "../application/inventory/transactionCapabilities";
import { buildInventoryApplicationContext, type InventoryApplicationContext } from "./inventoryApplicationContext";

function transactionCapability(db: any, driver: InventoryRepositoryDriver): PassThroughInventoryUnitOfWork {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      run<T>(work: (context: InventoryTransactionContext) => T | Promise<T>): T {
        let value: T;
        const execute = db.transaction((tx: DbClient) => {
          const result = work({ repositories: { inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, "synchronous") } });
          if (result && typeof (result as Promise<T>).then === "function")
            throw new Error("SQLITE_ASYNC_TRANSACTION_CALLBACK_REJECTED");
          value = result as T;
        });
        if (typeof execute === "function") execute();
        return value!;
      },
    } as PassThroughInventoryUnitOfWork;
  }
  if (driver === "postgres" || driver === "supabase-postgres") {
    return {
      driver,
      execution: "asynchronous",
      run: (work) => db.transaction((tx: unknown) => work({ repositories: { inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver) } })),
    } as PassThroughInventoryUnitOfWork;
  }
  throw new Error(`INVENTORY_TRANSACTION_CAPABILITY_DRIVER_MISMATCH:${driver}`);
}

export function createInventoryApplicationContextForDb(db: DbClient, driver: InventoryRepositoryDriver = "sqlite"): InventoryApplicationContext {
  return buildInventoryApplicationContext({
    repositories: createInventoryRepositoryBundleForDb(db, driver),
    unitOfWork: transactionCapability(db, driver),
    clock: { now: () => new Date() },
    idGenerator: { newId: () => crypto.randomUUID() },
    logger: {},
  });
}
