import type { DbClient } from "../db/client";
import type { ProductWriteTransactionCapabilityFor, ProductWriteTransactionDriver } from "../application/product-write/transactionCapabilities";
import { createProductWriteRepositoryBundleForDb, createSynchronousProductWriteRepositoryForDb } from "../repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";

export function createProductWriteTransactionCapabilityForDb<Driver extends ProductWriteTransactionDriver>(db: DbClient, driver: Driver): ProductWriteTransactionCapabilityFor<Driver> {
  if (driver === "sqlite" || driver === "test-memory") return { driver, execution: "synchronous", run(work) { let result: unknown; const transaction = db.transaction((tx) => { result = work({ repositories: { productWriteRepositories: { products: createSynchronousProductWriteRepositoryForDb(tx as any, driver) }, inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, true) } }); if (result instanceof Promise) throw new Error("SQLITE_ASYNC_PRODUCT_WRITE_TRANSACTION_CALLBACK_REJECTED"); }); if (typeof transaction === "function") (transaction as () => void)(); return result; } } as ProductWriteTransactionCapabilityFor<Driver>;
  return { driver, execution: "asynchronous", run: (work) => db.transaction(async (tx) => work({ repositories: { productWriteRepositories: { products: createProductWriteRepositoryBundleForDb(tx as any, driver).products }, inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver) } })) } as ProductWriteTransactionCapabilityFor<Driver>;
}

export function assertProductWriteTransactionCapabilityForDriver<Driver extends ProductWriteTransactionDriver>(driver: Driver, capability: ProductWriteTransactionCapabilityFor<Driver>): void {
  if (capability.driver !== driver) throw new Error(`PRODUCT_WRITE_TRANSACTION_DRIVER_MISMATCH:${driver}:${capability.driver}`);
  const expected = driver === "sqlite" || driver === "test-memory" ? "synchronous" : "asynchronous";
  if (capability.execution !== expected) throw new Error(`PRODUCT_WRITE_TRANSACTION_EXECUTION_MISMATCH:${driver}:${expected}:${capability.execution}`);
}
