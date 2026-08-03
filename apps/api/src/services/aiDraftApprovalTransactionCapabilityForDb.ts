import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";
import { createSynchronousProductWriteRepositoryForDb, createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { createDrizzleAiDraftApprovalRepository } from "../repositories/ai-draft/drizzle";
import type { AiDraftApprovalRepository, SynchronousAiDraftApprovalRepository } from "../repositories/ai-draft/types";
import type { AsynchronousProductWriteTransactionContext, SynchronousProductWriteTransactionContext } from "../application/product-write/transactionCapabilities";

/**
 * Sprint 89: the transaction context AI Draft approval needs - the same
 * productWriteRepositories/inventoryRepositories shape
 * updateProductWithInventoryInTransactionUseCase already expects, plus the
 * narrow ai-draft approval repository, all bound to one shared transaction
 * handle. This intentionally does NOT reuse productWriteTransactionCapabilityForDb
 * (that would require adding AI-Draft-table knowledge to the generic
 * product-write transaction capability); instead it opens its own single
 * transaction directly and builds both sets of repositories from the exact
 * same handle, reusing the already-exported repository-construction
 * functions those other capabilities use internally.
 */
export interface AiDraftApprovalTransactionContext {
  productWriteRepositories: AsynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"] | SynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"];
  inventoryRepositories: AsynchronousProductWriteTransactionContext["repositories"]["inventoryRepositories"];
  aiDraftApprovalRepository: AiDraftApprovalRepository | SynchronousAiDraftApprovalRepository;
}

export type AiDraftApprovalTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";

export interface AiDraftApprovalTransactionCapability {
  readonly driver: AiDraftApprovalTransactionDriver;
  readonly execution: "synchronous" | "asynchronous";
  run<T>(work: (ctx: AiDraftApprovalTransactionContext) => T | Promise<T>): T | Promise<T>;
}

export function createAiDraftApprovalTransactionCapabilityForDb(db: DbClient, driver: AiDraftApprovalTransactionDriver): AiDraftApprovalTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      run<T>(work: (ctx: AiDraftApprovalTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          result = work({
            productWriteRepositories: { products: createSynchronousProductWriteRepositoryForDb(tx, driver as "sqlite" | "test-memory") },
            inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver, true),
            aiDraftApprovalRepository: createDrizzleAiDraftApprovalRepository(tx, sqliteSchema, "synchronous"),
          });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_AI_DRAFT_APPROVAL_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    run<T>(work: (ctx: AiDraftApprovalTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction((tx: any) =>
        work({
          productWriteRepositories: { products: createProductWriteRepositoryBundleForDb(tx, driver, true).products },
          inventoryRepositories: createInventoryRepositoryBundleForDb(tx, driver),
          aiDraftApprovalRepository: createDrizzleAiDraftApprovalRepository(tx, postgresSchema, "asynchronous"),
        }),
      );
    },
  };
}
