import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";
import {
  createSynchronousProductWriteRepositoryForDb,
  createProductWriteRepositoryBundleForDb,
} from "../repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { applyIntakeWithExpectedStateInTransaction } from "../repositories/ai-product-intake/drizzle";
import type { AiProductIntakeApplyInput, AiProductIntakeApplyResult } from "../repositories/ai-product-intake/types";
import type {
  AsynchronousProductWriteTransactionContext,
  SynchronousProductWriteTransactionContext,
} from "../application/product-write/transactionCapabilities";

export type AiIntakeApplyTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
type Schema = typeof sqliteSchema | typeof postgresSchema;

// Mirrors repositories/ai-intake-proposal/drizzle.ts's exact then/rows/first helpers. Required
// here specifically because AiIntakeProposalRepository/AiIntakePhotoRepository's
// findByIntakeId/listByIntake methods are declared with the `async` keyword - an async function
// unconditionally returns a real (pending) Promise to its caller regardless of how synchronous
// the underlying driver call is, which would trip the SQLite branch's "callback must stay fully
// synchronous" guard below. The proposal/photo reads are therefore reimplemented here directly
// against tx using this execution-aware pattern, exactly like repositories/ai-intake-proposal/drizzle.ts's
// own updateFieldReviewAtomic/readOrderedPhotoIds do internally - never through those
// repositories' async-declared methods. The intake apply-write itself does NOT duplicate this -
// see applyIntake below, which delegates to the one production implementation in
// repositories/ai-product-intake/drizzle.ts.
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const first = (q: any, execution: Execution): Result<any> =>
  then(rows(q, execution), (values) => values[0] ?? null);

export interface AiIntakeApplyTransactionContext {
  tx: any;
  schema: Schema;
  execution: Execution;
  /** The locked intake row, already read, or null if it does not exist. */
  intake: Record<string, any> | null;
  /** Reads the current durable proposal for this intake, through tx. */
  readProposal(): Result<Record<string, any> | null>;
  /** Reads the intake's current staged-photo ids in listIntakePhotos's canonical created_at ASC, id ASC order, through tx. */
  readOrderedPhotoIds(): Result<string[]>;
  /**
   * Guarded conditional UPDATE: id matches, status is Open, resultProductId
   * is null. Delegates to repositories/ai-product-intake/drizzle.ts's
   * applyIntakeWithExpectedStateInTransaction - the single production
   * implementation of this rule, also used (execution="asynchronous") by
   * AiProductIntakeRepository.applyWithExpectedState for standalone callers.
   */
  applyIntake(input: Omit<AiProductIntakeApplyInput, "id">): Result<AiProductIntakeApplyResult>;
  productWriteRepositories:
    | AsynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"]
    | SynchronousProductWriteTransactionContext["repositories"]["productWriteRepositories"];
  inventoryRepositories: AsynchronousProductWriteTransactionContext["repositories"]["inventoryRepositories"];
}

export interface AiIntakeApplyTransactionCapability {
  readonly driver: AiIntakeApplyTransactionDriver;
  readonly execution: Execution;
  runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeApplyTransactionContext) => T | Promise<T>): T | Promise<T>;
}

function buildContext(
  intakeId: string,
  tx: any,
  schema: Schema,
  execution: Execution,
  intake: Record<string, any> | null,
  productWriteRepositories: AiIntakeApplyTransactionContext["productWriteRepositories"],
  inventoryRepositories: AiIntakeApplyTransactionContext["inventoryRepositories"],
): AiIntakeApplyTransactionContext {
  const proposalTable = (schema as Record<string, any>).aiIntakeProposals;
  const photoTable = (schema as Record<string, any>).aiIntakePhotos;
  return {
    tx,
    schema,
    execution,
    intake,
    readProposal: () => first(tx.select().from(proposalTable).where(eq(proposalTable.intakeId, intakeId)), execution),
    readOrderedPhotoIds: () =>
      then(
        rows(tx.select({ id: photoTable.id }).from(photoTable).where(eq(photoTable.intakeId, intakeId)).orderBy(asc(photoTable.createdAt), asc(photoTable.id)), execution),
        (photoRows) => photoRows.map((row: any) => row.id as string),
      ),
    applyIntake: (input) => applyIntakeWithExpectedStateInTransaction(tx, schema, execution, { id: intakeId, ...input }),
    productWriteRepositories,
    inventoryRepositories,
  };
}

/**
 * Sprint 94: one narrow intake-domain transaction capability for the Save as
 * Draft apply operation - reads the AiProductIntake, AiIntakeProposal, and
 * AiIntakePhoto tables AND binds the canonical Product-write/Inventory
 * repositories, all to one shared transaction handle, mirroring
 * services/aiDraftApprovalTransactionCapabilityForDb.ts's proven cross-domain
 * shape (that capability composes productWriteRepositories +
 * inventoryRepositories + one domain-specific repository bound to one tx;
 * this one adds the equivalent AI-intake-domain reads/write for the same
 * reason - the operation reads across two AI-intake tables and writes across
 * three tables, all inside one atomic transaction). Deliberately does NOT
 * extend services/productWriteTransactionCapabilityForDb.ts or
 * services/aiIntakeLockTransactionCapabilityForDb.ts, since that would
 * require adding cross-domain table knowledge to a capability other,
 * unrelated callers also use.
 *
 * Locking mirrors services/aiIntakeLockTransactionCapabilityForDb.ts exactly:
 * PostgreSQL uses SELECT ... FOR UPDATE inside the transaction before the
 * callback runs; SQLite relies on the whole callback executing synchronously,
 * with zero await/Promise boundaries, against the single connection this
 * codebase uses.
 */
export function createAiIntakeApplyTransactionCapabilityForDb(
  db: DbClient,
  driver: AiIntakeApplyTransactionDriver,
): AiIntakeApplyTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeApplyTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          const intakeTable = sqliteSchema.aiProductIntakes;
          const intakeRows = tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).all();
          const ctx = buildContext(
            intakeId,
            tx,
            sqliteSchema,
            "synchronous",
            intakeRows[0] ?? null,
            { products: createSynchronousProductWriteRepositoryForDb(tx, "sqlite") },
            createInventoryRepositoryBundleForDb(tx, "sqlite", true),
          );
          result = work(ctx);
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_AI_INTAKE_APPLY_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  const postgresDriver = driver as "postgres" | "supabase-postgres";
  return {
    driver,
    execution: "asynchronous",
    runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakeApplyTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction(async (tx: any) => {
        const intakeTable = postgresSchema.aiProductIntakes;
        const [intake] = await tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).for("update");
        const ctx = buildContext(
          intakeId,
          tx,
          postgresSchema,
          "asynchronous",
          intake ?? null,
          { products: createProductWriteRepositoryBundleForDb(tx, postgresDriver, true).products },
          createInventoryRepositoryBundleForDb(tx, postgresDriver),
        );
        return work(ctx);
      });
    },
  };
}
