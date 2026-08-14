import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";
import { createSynchronousProductWriteRepositoryForDb, createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { createDrizzleCanonicalProductProposalApprovalRepository } from "../repositories/canonical-product-proposal/drizzle";
import type {
  CanonicalProductProposalApprovalRepository,
  SynchronousCanonicalProductProposalApprovalRepository,
} from "../repositories/canonical-product-proposal/types";
import { createDrizzleTransactionalMarketingTagWriteRepository, type TransactionalMarketingTagWriteRepository } from "../repositories/marketing-tags/transactionalDrizzle";
import type { AsynchronousProductWriteTransactionContext, SynchronousProductWriteTransactionContext } from "../application/product-write/transactionCapabilities";

/**
 * Sprint 148: mirrors services/marketplacePreparationApprovalTransactionCapabilityForDb.ts
 * exactly, extended with a transaction-scoped Marketing Tag write repository so Accept can apply
 * selected Product fields AND selected Marketing Tags as one atomic operation (Architecture
 * Review requirement L - the proposal must never be marked Applied if either mutation failed).
 * inventoryRepositories is present only because updateProductWithInventoryInTransactionUseCase's
 * parameter type requires it structurally - canonical Accept never actually touches Inventory
 * (the values object passed to that use-case never includes stockQuantity).
 */
export interface CanonicalProductProposalApprovalTransactionContext {
  productWriteRepositories: AsynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"] | SynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"];
  inventoryRepositories: AsynchronousProductWriteTransactionContext["repositories"]["inventoryRepositories"];
  canonicalProductProposalApprovalRepository: CanonicalProductProposalApprovalRepository | SynchronousCanonicalProductProposalApprovalRepository;
  marketingTagWriteRepository: TransactionalMarketingTagWriteRepository;
}

export type CanonicalProductProposalApprovalTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";

export interface CanonicalProductProposalApprovalTransactionCapability {
  readonly driver: CanonicalProductProposalApprovalTransactionDriver;
  readonly execution: "synchronous" | "asynchronous";
  run<T>(work: (ctx: CanonicalProductProposalApprovalTransactionContext) => T | Promise<T>): T | Promise<T>;
}

export function createCanonicalProductProposalApprovalTransactionCapabilityForDb(
  db: DbClient,
  driver: CanonicalProductProposalApprovalTransactionDriver,
): CanonicalProductProposalApprovalTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      run<T>(work: (ctx: CanonicalProductProposalApprovalTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          result = work({
            productWriteRepositories: { products: createSynchronousProductWriteRepositoryForDb(tx, driver as "sqlite" | "test-memory") },
            inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, true),
            canonicalProductProposalApprovalRepository: createDrizzleCanonicalProductProposalApprovalRepository(tx, sqliteSchema, "synchronous"),
            marketingTagWriteRepository: createDrizzleTransactionalMarketingTagWriteRepository(tx, sqliteSchema, "synchronous"),
          });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_CANONICAL_PRODUCT_PROPOSAL_APPROVAL_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    run<T>(work: (ctx: CanonicalProductProposalApprovalTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction((tx: any) =>
        work({
          productWriteRepositories: { products: createProductWriteRepositoryBundleForDb(tx, driver, true).products },
          inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver),
          canonicalProductProposalApprovalRepository: createDrizzleCanonicalProductProposalApprovalRepository(tx, postgresSchema, "asynchronous"),
          marketingTagWriteRepository: createDrizzleTransactionalMarketingTagWriteRepository(tx, postgresSchema, "asynchronous"),
        }),
      );
    },
  };
}
