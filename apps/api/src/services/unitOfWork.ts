import type { DbClient } from "../db/client";
import { createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";
import type { ProductWriteRepositoryBundle } from "../repositories/product-write/types";
import { createStockMovementRepositoryBundleForDb } from "../repositories/stock/factory";
import type { StockMovementRepositoryBundle } from "../repositories/stock/types";
import { createOrderRepositoryBundleForDb } from "../repositories/order/factory";
import type { OrderRepositoryBundle } from "../repositories/order/types";
import { createReturnRepositoryBundleForDb } from "../repositories/return/factory";
import type { ReturnRepositoryBundle } from "../repositories/return/types";
import { createRefundRepositoriesForDb } from "../repositories/refund/factory";
import type { RefundRepositories } from "../repositories/refund/types";

export interface UnitOfWorkResult<T> { ok: true; value: T }
export interface UnitOfWorkError { code: string; message: string; cause?: unknown }
export interface CompensatingAction { name: string; run(): void | Promise<void> }
export interface ApplicationUseCase<I, O> { execute(input: I): Promise<O> }

export interface TransactionScopedRepositories {
  db: DbClient;
  productWrite: ProductWriteRepositoryBundle;
  stock: StockMovementRepositoryBundle;
  order: OrderRepositoryBundle;
  returnRepositories: ReturnRepositoryBundle;
  refund: RefundRepositories;
}

export interface UnitOfWorkContext {
  repositories: TransactionScopedRepositories;
}

export interface UnitOfWork {
  run<T>(work: (context: UnitOfWorkContext) => T | Promise<T>): Promise<T>;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === "function";
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: DbClient) {}
  async run<T>(work: (context: UnitOfWorkContext) => T | Promise<T>): Promise<T> {
    let result!: T;
    const txRunner = this.db.transaction((tx) => {
      const maybe = work({ repositories: { db: tx as unknown as DbClient, productWrite: createProductWriteRepositoryBundleForDb(tx as unknown as DbClient, "sqlite"), stock: createStockMovementRepositoryBundleForDb(tx as unknown as DbClient, "sqlite"), order: createOrderRepositoryBundleForDb(tx as unknown as DbClient, "sqlite"), returnRepositories: createReturnRepositoryBundleForDb(tx as unknown as DbClient, "sqlite"), refund: createRefundRepositoriesForDb(tx as unknown as DbClient, "sqlite") } });
      if (isPromiseLike(maybe)) throw new Error("SQLITE_ASYNC_TRANSACTION_CALLBACK_REJECTED");
      result = maybe;
    });
    if (typeof txRunner === "function") (txRunner as () => void)();
    return result;
  }
}

export interface PostgresTransactionAdapter<TTx = DbClient> {
  transaction<T>(work: (tx: TTx) => Promise<T>): Promise<T>;
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly adapter: PostgresTransactionAdapter) {}
  async run<T>(work: (context: UnitOfWorkContext) => T | Promise<T>): Promise<T> {
    try {
      return await this.adapter.transaction(async (tx) => work({ repositories: { db: tx as DbClient, productWrite: createProductWriteRepositoryBundleForDb(tx as DbClient, "postgres"), stock: createStockMovementRepositoryBundleForDb(tx as DbClient, "postgres"), order: createOrderRepositoryBundleForDb(tx as DbClient, "postgres"), returnRepositories: createReturnRepositoryBundleForDb(tx as DbClient, "postgres"), refund: createRefundRepositoriesForDb(tx as DbClient, "postgres") } }));
    } catch (cause) {
      const err = new Error("POSTGRES_TRANSACTION_FAILED");
      (err as Error & { cause?: unknown }).cause = cause;
      throw err;
    }
  }
}
