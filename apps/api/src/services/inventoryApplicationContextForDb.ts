import crypto from "node:crypto";
import type { DbClient } from "../db/client";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import type { InventoryRepositoryDriver } from "../repositories/inventory/factory";
import type { InventoryTransactionCapabilityFor, InventoryTransactionDriver } from "../application/inventory/transactionCapabilities";
import { buildInventoryApplicationContext, type InventoryApplicationContext } from "./inventoryApplicationContext";

export function createInventoryTransactionCapabilityForDb<Driver extends InventoryTransactionDriver>(
  db: DbClient,
  driver: Driver,
): InventoryTransactionCapabilityFor<Driver> {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      run(work) {
        let result: unknown;
        const transaction = db.transaction((tx) => {
          result = work({ repositories: { inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, true) } });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    } as InventoryTransactionCapabilityFor<Driver>;
  }
  return {
    driver,
    execution: "asynchronous",
    run: (work) => db.transaction(async (tx) => work({ repositories: { inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver) } })),
  } as InventoryTransactionCapabilityFor<Driver>;
}

export function createInventoryApplicationContextForDb<Driver extends InventoryTransactionDriver>(
  db: DbClient,
  driver: Driver = ((process.env.DATABASE_DRIVER as Driver) || "sqlite" as Driver),
  capability: InventoryTransactionCapabilityFor<Driver> = createInventoryTransactionCapabilityForDb(db, driver),
): InventoryApplicationContext {
  if (capability.driver !== driver) throw new Error(`INVENTORY_TRANSACTION_DRIVER_MISMATCH:${driver}:${capability.driver}`);
  return buildInventoryApplicationContext({
    repositories: createInventoryRepositoryBundleForDb(db, driver as InventoryRepositoryDriver),
    unitOfWork: capability as never,
    clock: { now: () => new Date() },
    idGenerator: { newId: () => crypto.randomUUID() },
    logger: {},
  });
}
