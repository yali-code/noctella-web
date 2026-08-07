import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";
import { createSynchronousProductWriteRepositoryForDb, createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { createDrizzleMarketplacePreparationApprovalRepository } from "../repositories/marketplace-preparation/drizzle";
import type {
  MarketplacePreparationApprovalRepository,
  SynchronousMarketplacePreparationApprovalRepository,
} from "../repositories/marketplace-preparation/types";
import type { AsynchronousProductWriteTransactionContext, SynchronousProductWriteTransactionContext } from "../application/product-write/transactionCapabilities";

/**
 * Sprint 107: mirrors services/aiDraftApprovalTransactionCapabilityForDb.ts
 * exactly - the transaction context marketplace-preparation approval needs
 * (the same productWriteRepositories/inventoryRepositories shape
 * updateProductWithInventoryInTransactionUseCase already expects, plus the
 * narrow marketplace-preparation approval repository), all bound to one
 * shared transaction handle. inventoryRepositories is present only because
 * updateProductWithInventoryInTransactionUseCase's parameter type requires
 * it structurally (matching AiDraftApprovalTransactionContext's identical
 * precedent) - Sprint 107 approval never actually touches Inventory/stock:
 * the values object passed to that use-case never includes stockQuantity,
 * so its own undefined-check short-circuits before any inventory repository
 * method is ever called.
 */
export interface MarketplacePreparationApprovalTransactionContext {
  productWriteRepositories: AsynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"] | SynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"];
  inventoryRepositories: AsynchronousProductWriteTransactionContext["repositories"]["inventoryRepositories"];
  marketplacePreparationApprovalRepository: MarketplacePreparationApprovalRepository | SynchronousMarketplacePreparationApprovalRepository;
}

export type MarketplacePreparationApprovalTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";

export interface MarketplacePreparationApprovalTransactionCapability {
  readonly driver: MarketplacePreparationApprovalTransactionDriver;
  readonly execution: "synchronous" | "asynchronous";
  run<T>(work: (ctx: MarketplacePreparationApprovalTransactionContext) => T | Promise<T>): T | Promise<T>;
}

export function createMarketplacePreparationApprovalTransactionCapabilityForDb(
  db: DbClient,
  driver: MarketplacePreparationApprovalTransactionDriver,
): MarketplacePreparationApprovalTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      run<T>(work: (ctx: MarketplacePreparationApprovalTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          result = work({
            productWriteRepositories: { products: createSynchronousProductWriteRepositoryForDb(tx, driver as "sqlite" | "test-memory") },
            inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, true),
            marketplacePreparationApprovalRepository: createDrizzleMarketplacePreparationApprovalRepository(tx, sqliteSchema, "synchronous"),
          });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_MARKETPLACE_PREPARATION_APPROVAL_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    run<T>(work: (ctx: MarketplacePreparationApprovalTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction((tx: any) =>
        work({
          productWriteRepositories: { products: createProductWriteRepositoryBundleForDb(tx, driver, true).products },
          inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver),
          marketplacePreparationApprovalRepository: createDrizzleMarketplacePreparationApprovalRepository(tx, postgresSchema, "asynchronous"),
        }),
      );
    },
  };
}
