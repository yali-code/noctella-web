import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqliteSchema from "../db/schema.sqlite";
import * as postgresSchema from "../db/schema.postgres";
import {
  createProductPhotoWithPromotionOutboxInTransaction,
  findProductPhotosByIdsInTransaction,
  listProductPhotosInTransaction,
} from "../repositories/product-write/drizzle";
import { finalizeIntakeWithExpectedStateInTransaction } from "../repositories/ai-product-intake/drizzle";
import type { AiProductIntakeFinalizeInput, AiProductIntakeFinalizeResult } from "../repositories/ai-product-intake/types";
import { lockProductRowInTransaction } from "./productPhotoMutationLockTransactionCapabilityForDb";

export type AiIntakePhotoFinalizeTransactionDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
type Schema = typeof sqliteSchema | typeof postgresSchema;

// Mirrors aiIntakeApplyTransactionCapabilityForDb.ts's exact then/rows helpers, for the exact same
// reason: AiIntakePhotoRepository.listByIntake is declared with the `async` keyword - an async
// function unconditionally returns a real (pending) Promise regardless of how synchronous the
// underlying driver call is, which would trip the SQLite branch's "callback must stay fully
// synchronous" guard below. The staged-photo read is therefore reimplemented here directly
// against tx using this execution-aware pattern, never through that repository's async-declared
// method.
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);

export interface StagedIntakePhotoForFinalization {
  id: string;
  storageKey: string;
}

export interface AiIntakePhotoFinalizeTransactionContext {
  tx: any;
  schema: Schema;
  execution: Execution;
  /** The locked AiProductIntake row, already read, or null if it does not exist. */
  intake: Record<string, any> | null;
  /**
   * Locks the given Product row (the intake's resultProductId) inside this
   * same transaction - see productPhotoMutationLockTransactionCapabilityForDb.ts's
   * lockProductRowInTransaction, the same function uploadProductPhoto's
   * standalone lock capability uses. Acquired on demand rather than upfront,
   * since the target Product id is only known after the intake row (read
   * above) has been inspected.
   */
  lockProduct(productId: string): Result<Record<string, any> | null>;
  /** Reads the intake's current staged photos, in canonical created_at ASC, id ASC order. */
  readOrderedStagedPhotos(): Result<StagedIntakePhotoForFinalization[]>;
  /** Reads existing canonical ProductPhoto rows for the given Product. */
  listExistingProductPhotos(productId: string): Result<any[]>;
  /** Finds any existing ProductPhoto rows among the given deterministic ids, regardless of Product. */
  findExistingProductPhotosByIds(ids: string[]): Result<any[]>;
  /** Creates one canonical ProductPhoto row and enqueues its ProductPhotoPromoteRequested outbox event. */
  createProductPhoto(input: { values: Record<string, unknown>; outboxEvent: Record<string, unknown> }): Result<{ id: string }>;
  /** Guarded conditional UPDATE: id matches, status is Applied. */
  finalizeIntake(input: Omit<AiProductIntakeFinalizeInput, "id">): Result<AiProductIntakeFinalizeResult>;
}

export interface AiIntakePhotoFinalizeTransactionCapability {
  readonly driver: AiIntakePhotoFinalizeTransactionDriver;
  readonly execution: Execution;
  runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakePhotoFinalizeTransactionContext) => T | Promise<T>): T | Promise<T>;
}

function buildContext(
  intakeId: string,
  tx: any,
  schema: Schema,
  execution: Execution,
  intake: Record<string, any> | null,
): AiIntakePhotoFinalizeTransactionContext {
  const photoTable = (schema as Record<string, any>).aiIntakePhotos;
  return {
    tx,
    schema,
    execution,
    intake,
    lockProduct: (productId) => lockProductRowInTransaction(tx, schema, execution, productId),
    readOrderedStagedPhotos: () =>
      then(
        rows(
          tx.select().from(photoTable).where(eq(photoTable.intakeId, intakeId)).orderBy(asc(photoTable.createdAt), asc(photoTable.id)),
          execution,
        ),
        (photoRows) => photoRows.map((row: any) => ({ id: row.id as string, storageKey: row.storageKey as string })),
      ),
    listExistingProductPhotos: (productId) => listProductPhotosInTransaction(tx, schema, execution, productId),
    findExistingProductPhotosByIds: (ids) => findProductPhotosByIdsInTransaction(tx, schema, execution, ids),
    createProductPhoto: (input) => createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, input),
    finalizeIntake: (input) => finalizeIntakeWithExpectedStateInTransaction(tx, schema, execution, { id: intakeId, ...input }),
  };
}

/**
 * Sprint 95: one narrow intake-domain transaction capability for the
 * finalize-photos operation - mirrors
 * services/aiIntakeApplyTransactionCapabilityForDb.ts's proven cross-domain
 * shape (locks the AiProductIntake row first, exposes staged-photo reads,
 * canonical ProductPhoto writes, and the guarded finalization UPDATE, all
 * bound to one shared transaction handle). Unlike the Sprint 94 capability,
 * this one does not bind the full canonical Product-write repository bundle
 * - finalization never creates or mutates a Product, only reads (via
 * lockProduct) and creates ProductPhoto rows, so only the narrow functions
 * that operation actually needs are exposed.
 *
 * Locking mirrors services/aiIntakeApplyTransactionCapabilityForDb.ts and
 * services/aiIntakeLockTransactionCapabilityForDb.ts exactly: PostgreSQL
 * uses SELECT ... FOR UPDATE inside the transaction for both the intake and
 * (via lockProduct) Product rows; SQLite relies on the whole callback
 * executing synchronously, with zero await/Promise boundaries, against the
 * single connection this codebase uses.
 */
export function createAiIntakePhotoFinalizeTransactionCapabilityForDb(
  db: DbClient,
  driver: AiIntakePhotoFinalizeTransactionDriver,
): AiIntakePhotoFinalizeTransactionCapability {
  if (driver === "sqlite" || driver === "test-memory") {
    return {
      driver,
      execution: "synchronous",
      runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakePhotoFinalizeTransactionContext) => T): T {
        let result!: T;
        const transaction = (db as any).transaction((tx: any) => {
          const intakeTable = sqliteSchema.aiProductIntakes;
          const intakeRows = tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).all();
          const ctx = buildContext(intakeId, tx, sqliteSchema, "synchronous", intakeRows[0] ?? null);
          result = work(ctx);
          if (result instanceof Promise) throw new Error("SQLITE_ASYNC_AI_INTAKE_PHOTO_FINALIZE_TRANSACTION_CALLBACK_REJECTED");
        });
        if (typeof transaction === "function") (transaction as () => void)();
        return result;
      },
    };
  }
  return {
    driver,
    execution: "asynchronous",
    runWithLockedIntake<T>(intakeId: string, work: (ctx: AiIntakePhotoFinalizeTransactionContext) => T | Promise<T>): Promise<T> {
      return (db as any).transaction(async (tx: any) => {
        const intakeTable = postgresSchema.aiProductIntakes;
        const [intake] = await tx.select().from(intakeTable).where(eq(intakeTable.id, intakeId)).for("update");
        const ctx = buildContext(intakeId, tx, postgresSchema, "asynchronous", intake ?? null);
        return work(ctx);
      });
    },
  };
}
