import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";

export type ProductPhotoMutationLockDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

/**
 * Sprint 95: the single production implementation of "read the owning
 * Product row for update, inside an already-open transaction" - a normal
 * canonical ProductPhoto upload can otherwise race a Sprint 95 finalization
 * between checking the current photo count, assigning the sole Primary, and
 * inserting the finalized photo set. Callable two ways: standalone, via
 * createProductPhotoMutationLockCapabilityForDb's runWithLockedProduct
 * (which opens its own transaction, used by uploadProductPhoto); or directly,
 * against a transaction another lock (e.g. the Sprint 93/94 intake-row lock)
 * has already opened, so the finalization transaction can lock both the
 * intake row and the Product row inside one transaction without nesting a
 * second one. PostgreSQL: SELECT ... FOR UPDATE - a concurrent writer
 * touching the same Product row blocks until this transaction commits or
 * rolls back. SQLite: a plain SELECT is sufficient - the caller's whole
 * transaction callback already runs synchronously with zero await/Promise
 * boundaries, so no other request handler's synchronous SQLite call can
 * interleave mid-callback.
 */
export function lockProductRowInTransaction(tx: any, schema: Schema, execution: Execution, productId: string): Result<Record<string, any> | null> {
  const productsTable = (schema as Record<string, any>).products;
  if (execution === "synchronous") {
    const productRows = tx.select().from(productsTable).where(eq(productsTable.id, productId)).all();
    return productRows[0] ?? null;
  }
  return tx
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, productId))
    .for("update")
    .then((productRows: any[]) => productRows[0] ?? null);
}

export interface ProductPhotoMutationLockContext {
  tx: any;
  schema: Schema;
  execution: Execution;
  /** The locked Product row, already read, or null if it does not exist. */
  product: Record<string, any> | null;
}

export interface ProductPhotoMutationLockCapability {
  readonly driver: ProductPhotoMutationLockDriver;
  readonly execution: Execution;
  runWithLockedProduct<T>(productId: string, work: (ctx: ProductPhotoMutationLockContext) => T | Promise<T>): T | Promise<T>;
}

/**
 * Standalone capability for a caller (uploadProductPhoto) that does not
 * already own an open transaction - opens one, locks the Product row via
 * lockProductRowInTransaction, then runs the work callback inside it.
 */
export function createProductPhotoMutationLockCapabilityForDb(db: DbClient, driver: ProductPhotoMutationLockDriver): ProductPhotoMutationLockCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      runWithLockedProduct<T>(productId: string, work: (ctx: ProductPhotoMutationLockContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          const product = lockProductRowInTransaction(tx, sqliteSchema, "synchronous", productId) as Record<string, any> | null;
          result = work({ tx, schema: sqliteSchema, execution: "synchronous", product });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_PRODUCT_PHOTO_MUTATION_LOCK_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    runWithLockedProduct<T>(productId: string, work: (ctx: ProductPhotoMutationLockContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction(async (tx: any) => {
        const product = (await lockProductRowInTransaction(tx, postgresSchema, "asynchronous", productId)) as Record<string, any> | null;
        return work({ tx, schema: postgresSchema, execution: "asynchronous", product });
      });
    },
  };
}
