import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";

export type AiIntakeLockTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";

/**
 * Sprint 93 correction pass: the ai_product_intakes row is the single
 * serialization point for every database mutation that can affect proposal
 * validity - first proposal insertion, regeneration, field-review writes, and
 * staged-photo insert/delete. Locking (or, for SQLite, synchronously reading
 * with no interleaving possible - see below) this row before any of those
 * writes closes every TOCTOU window between them.
 *
 * PostgreSQL: SELECT ... FOR UPDATE inside the transaction - a concurrent
 * writer touching the same intake row blocks until this transaction commits
 * or rolls back, so a plain READ COMMITTED snapshot read can never be acted
 * on after it has gone stale.
 *
 * SQLite (better-sqlite3): the whole work callback runs synchronously, with
 * zero await/Promise boundaries, against the single connection this codebase
 * uses (db/client.ts's singleton). Node's single-threaded execution model
 * means no other request handler's synchronous SQLite call can interleave
 * mid-callback, so a plain SELECT already gives the same practical guarantee
 * without needing (or SQLite supporting) row-level locking.
 */
export interface AiIntakeLockTransactionContext {
  tx: any;
  schema: typeof sqliteSchema | typeof postgresSchema;
  execution: "synchronous" | "asynchronous";
  /** The locked intake row, already read, or null if it does not exist. */
  intake: Record<string, any> | null;
}

export interface AiIntakeLockTransactionCapability {
  readonly driver: AiIntakeLockTransactionDriver;
  readonly execution: "synchronous" | "asynchronous";
  runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeLockTransactionContext) => T | Promise<T>): T | Promise<T>;
}

export function createAiIntakeLockTransactionCapabilityForDb(db: DbClient, driver: AiIntakeLockTransactionDriver): AiIntakeLockTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeLockTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          const intakeTable = sqliteSchema.aiProductIntakes;
          const intakeRows = tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).all();
          result = work({ tx, schema: sqliteSchema, execution: "synchronous", intake: intakeRows[0] ?? null });
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_AI_INTAKE_LOCK_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeLockTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction(async (tx: any) => {
        const intakeTable = postgresSchema.aiProductIntakes;
        const [intake] = await tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).for("update");
        return work({ tx, schema: postgresSchema, execution: "asynchronous", intake: intake ?? null });
      });
    },
  };
}
