import { and, asc, eq } from "drizzle-orm";
import { AiProductIntakeStatus } from "@noctella/shared";
import * as sqliteSchemaModule from "../../db/schema.sqlite";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import type { AiIntakePhotoCreateInput, AiIntakePhotoRecord, AiIntakePhotoRepository, AiIntakePhotoWriteResult } from "./types";
import {
  createAiIntakeLockTransactionCapabilityForDb,
  type AiIntakeLockTransactionCapability,
} from "../../services/aiIntakeLockTransactionCapabilityForDb";

type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const run = (q: any, execution: Execution): Result<unknown> => (execution === "synchronous" ? q.run() : Promise.resolve(q));

/**
 * Sprint 91: no dedicated transaction capability for the plain single-
 * statement operations below - each runs directly against whatever db handle
 * is passed in. Takes an explicit schema module (mirroring
 * repositories/ai-product-intake/drizzle.ts) so the same code works against
 * either dialect's table object.
 *
 * Sprint 93 correction pass: `capability` is optional and, if omitted, is
 * constructed from `db`/`schema` (matching repositories/ai-intake-proposal's
 * convention) - this keeps existing direct-construction call sites (tests)
 * working unchanged while the real factory always passes an explicit one.
 */
export function createDrizzleAiIntakePhotoRepository(db: any, schema: Schema, capability?: AiIntakeLockTransactionCapability): AiIntakePhotoRepository {
  const table = (schema as Record<string, any>).aiIntakePhotos;
  const lock = capability ?? createAiIntakeLockTransactionCapabilityForDb(db, schema === sqliteSchemaModule ? "sqlite" : "postgres");
  return {
    async create(input: AiIntakePhotoCreateInput): Promise<AiIntakePhotoRecord> {
      await db.insert(table).values({
        id: input.id,
        intakeId: input.intakeId,
        storageKey: input.storageKey,
        originalFilename: input.originalFilename,
        createdByAdminUserId: input.createdByAdminUserId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      const [row] = await db.select().from(table).where(eq(table.id, input.id));
      return row as AiIntakePhotoRecord;
    },

    async listByIntake(intakeId: string): Promise<AiIntakePhotoRecord[]> {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.intakeId, intakeId))
        .orderBy(asc(table.createdAt), asc(table.id));
      return rows as AiIntakePhotoRecord[];
    },

    async findByIdAndIntake(intakeId: string, id: string): Promise<AiIntakePhotoRecord | null> {
      const [row] = await db.select().from(table).where(and(eq(table.id, id), eq(table.intakeId, intakeId)));
      return (row as AiIntakePhotoRecord) ?? null;
    },

    async deleteById(id: string): Promise<void> {
      await db.delete(table).where(eq(table.id, id));
    },

    async createLockedIfIntakeOpen(input: AiIntakePhotoCreateInput): Promise<AiIntakePhotoWriteResult> {
      return lock.runWithLockedIntake(input.intakeId, ({ tx, schema: txSchema, execution, intake }) => {
        if (!intake) return { updated: false, conflict: { reason: "intake_not_found" as const, message: "AI product intake not found" } };
        if (intake.status !== AiProductIntakeStatus.Open) {
          return { updated: false, conflict: { reason: "intake_not_open" as const, message: "AI product intake is not Open" } };
        }
        const txTable = (txSchema as Record<string, any>).aiIntakePhotos;
        return then(
          rows(
            tx
              .insert(txTable)
              .values({
                id: input.id,
                intakeId: input.intakeId,
                storageKey: input.storageKey,
                originalFilename: input.originalFilename,
                createdByAdminUserId: input.createdByAdminUserId,
                createdAt: input.createdAt,
                updatedAt: input.updatedAt,
              })
              .returning(),
            execution,
          ),
          (inserted: any[]) => ({ updated: true, row: inserted[0] as AiIntakePhotoRecord }),
        );
      }) as Promise<AiIntakePhotoWriteResult>;
    },

    async deleteByIdLockedToIntake(intakeId: string, id: string): Promise<void> {
      await lock.runWithLockedIntake(intakeId, ({ tx, schema: txSchema, execution }) => {
        const txTable = (txSchema as Record<string, any>).aiIntakePhotos;
        return then(run(tx.delete(txTable).where(eq(txTable.id, id)), execution), () => undefined);
      });
    },
  };
}
