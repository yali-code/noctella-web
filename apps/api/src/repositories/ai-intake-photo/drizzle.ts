import { and, asc, eq } from "drizzle-orm";
import { AiProductIntakeStatus } from "@noctella/shared";
import * as sqliteSchemaModule from "../../db/schema.sqlite";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import type {
  AiIntakePhotoCreateInput,
  AiIntakePhotoDeleteConflict,
  AiIntakePhotoDeleteResult,
  AiIntakePhotoRecord,
  AiIntakePhotoRepository,
  AiIntakePhotoWriteResult,
} from "./types";
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
 * Sprint 95 final correction: the single production implementation of "is
 * this intake's current status allowed to have a staged photo deleted" -
 * allowlisted (Open, Cancelled), never a blocklist, so any future status
 * this file doesn't yet know about fails closed. Used once, inside
 * deleteLockedToIntake's single locked transaction.
 */
const DELETION_ALLOWED_STATUSES: ReadonlySet<string> = new Set([AiProductIntakeStatus.Open, AiProductIntakeStatus.Cancelled]);

function checkIntakeDeletable(intake: Record<string, any> | null): { allowed: true } | { allowed: false; conflict: AiIntakePhotoDeleteConflict } {
  if (!intake) return { allowed: false, conflict: { reason: "intake_not_found", message: "AI product intake not found" } };
  if (!DELETION_ALLOWED_STATUSES.has(intake.status)) {
    return {
      allowed: false,
      conflict: { reason: "intake_not_deletable", message: `Staged photos cannot be deleted once the intake is "${intake.status}"` },
    };
  }
  return { allowed: true };
}

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

    async deleteLockedToIntake(intakeId: string, id: string): Promise<AiIntakePhotoDeleteResult> {
      return lock.runWithLockedIntake(intakeId, ({ tx, schema: txSchema, execution, intake }) => {
        const gate = checkIntakeDeletable(intake);
        if (!gate.allowed) return { deleted: false, conflict: gate.conflict } as AiIntakePhotoDeleteResult;

        const txTable = (txSchema as Record<string, any>).aiIntakePhotos;
        return then(
          rows(tx.select().from(txTable).where(and(eq(txTable.id, id), eq(txTable.intakeId, intakeId))), execution),
          (photoRows: any[]) => {
            const photo = photoRows[0];
            if (!photo) {
              return { deleted: false, conflict: { reason: "photo_not_found" as const, message: "AI intake photo not found" } } as AiIntakePhotoDeleteResult;
            }

            // A pure database delete - no filesystem operation of any kind
            // happens here or anywhere in this transaction, so no rollback
            // compensation is ever needed: whatever fails (the DELETE
            // statement itself, or the commit that follows this callback's
            // return), the row and the staged file are simply left exactly
            // as they were.
            return then(run(tx.delete(txTable).where(eq(txTable.id, id)), execution), () => ({
              deleted: true,
              storageKey: photo.storageKey as string,
            } as AiIntakePhotoDeleteResult));
          },
        );
      }) as Promise<AiIntakePhotoDeleteResult>;
    },
  };
}
