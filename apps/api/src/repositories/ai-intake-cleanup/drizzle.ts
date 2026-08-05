import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { AiProductIntakeStatus } from "@noctella/shared";
import { OutboxEventStatus } from "../../services/outbox";
import * as sqliteSchemaModule from "../../db/schema.sqlite";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import { AiIntakePhotoDeleteIntegrityFailureError } from "../../services/errors";
import {
  createAiIntakeLockTransactionCapabilityForDb,
  type AiIntakeLockTransactionCapability,
} from "../../services/aiIntakeLockTransactionCapabilityForDb";
import type {
  AiIntakeCleanupCandidateIntake,
  AiIntakeCleanupRepository,
  AiIntakeRetentionCleanupRequest,
  AiIntakeRetentionCleanupResult,
} from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);

/**
 * Sprint 96 correction pass: a fail-safe BLOCKLIST of known-terminal outbox
 * statuses, not an allowlist of known-non-terminal ones - any status not in
 * this list (including a hypothetical future addition to OutboxEventStatus)
 * is treated as protective by default, matching the same allowlist-vs-
 * blocklist fail-closed convention already established for
 * DELETION_ALLOWED_STATUSES's inverse in repositories/ai-intake-photo/drizzle.ts
 * (that one is deliberately an allowlist because its default must be
 * "not deletable"; this one is deliberately a blocklist because its default
 * must be "protected").
 */
const TERMINAL_OUTBOX_STATUSES = [
  OutboxEventStatus.Succeeded,
  OutboxEventStatus.Failed,
  OutboxEventStatus.DeadLetter,
  OutboxEventStatus.Cancelled,
] as const;

/** Maps a strict request variant to its exactly-one expected status and exactly-one audit field - never an arbitrary caller-supplied column/status. */
function resolveRetentionRequest(request: AiIntakeRetentionCleanupRequest) {
  if (request.kind === "cancelled") return { expectedStatus: AiProductIntakeStatus.Cancelled, auditField: "cancelledAt" as const };
  return { expectedStatus: AiProductIntakeStatus.Finalized, auditField: "finalizedAt" as const };
}

export function createDrizzleAiIntakeCleanupRepository(db: any, schema: Schema, capability?: AiIntakeLockTransactionCapability): AiIntakeCleanupRepository {
  const s = schema as Record<string, any>;
  const intakeTable = s.aiProductIntakes;
  const photoTable = s.aiIntakePhotos;
  const productPhotoTable = s.productPhotos;
  const outboxTable = s.outboxEvents;
  const lock = capability ?? createAiIntakeLockTransactionCapabilityForDb(db, schema === sqliteSchemaModule ? "sqlite" : "postgres");

  return {
    async listTerminalIntakesWithStagedPhotosEligibleForRetention(input): Promise<AiIntakeCleanupCandidateIntake[]> {
      const stagedIntakeIds = db.select({ intakeId: photoTable.intakeId }).from(photoTable);
      const result = await db
        .select({
          id: intakeTable.id,
          status: intakeTable.status,
          cancelledAt: intakeTable.cancelledAt,
          finalizedAt: intakeTable.finalizedAt,
        })
        .from(intakeTable)
        .where(
          and(
            inArray(intakeTable.id, stagedIntakeIds),
            sql`(
              (${intakeTable.status} = ${AiProductIntakeStatus.Cancelled} AND ${intakeTable.cancelledAt} IS NOT NULL AND ${intakeTable.cancelledAt} <= ${input.cancelledCutoff})
              OR
              (${intakeTable.status} = ${AiProductIntakeStatus.Finalized} AND ${intakeTable.finalizedAt} IS NOT NULL AND ${intakeTable.finalizedAt} <= ${input.finalizedCutoff})
            )`,
          ),
        )
        .orderBy(
          sql`CASE
              WHEN ${intakeTable.status} = ${AiProductIntakeStatus.Cancelled} THEN ${intakeTable.cancelledAt}
              WHEN ${intakeTable.status} = ${AiProductIntakeStatus.Finalized} THEN ${intakeTable.finalizedAt}
              ELSE NULL
            END ASC`,
          asc(intakeTable.id),
        )
        .limit(input.limit);
      return result as AiIntakeCleanupCandidateIntake[];
    },

    async deleteRetentionEligibleStagedPhotosLocked(
      intakeId: string,
      request: AiIntakeRetentionCleanupRequest,
      remainingBudget: number,
    ): Promise<AiIntakeRetentionCleanupResult> {
      if (remainingBudget <= 0) return { cleaned: true, deletedPhotos: [] };
      return lock.runWithLockedIntake(intakeId, ({ tx, schema: txSchema, execution, intake }) => {
        const txS = txSchema as Record<string, any>;
        const { expectedStatus, auditField } = resolveRetentionRequest(request);

        if (!intake) return { cleaned: false, reason: "not_found" } as AiIntakeRetentionCleanupResult;
        if (intake.status !== expectedStatus) return { cleaned: false, reason: "status_changed" } as AiIntakeRetentionCleanupResult;
        const auditTimestamp = intake[auditField] as string | null | undefined;
        if (!auditTimestamp) return { cleaned: false, reason: "missing_audit_timestamp" } as AiIntakeRetentionCleanupResult;
        if (new Date(auditTimestamp).getTime() > new Date(request.cutoff).getTime()) {
          return { cleaned: false, reason: "not_yet_eligible" } as AiIntakeRetentionCleanupResult;
        }

        const txPhotoTable = txS.aiIntakePhotos;
        return then(
          rows(
            tx
              .select()
              .from(txPhotoTable)
              .where(eq(txPhotoTable.intakeId, intakeId))
              .orderBy(asc(txPhotoTable.createdAt), asc(txPhotoTable.id))
              .limit(remainingBudget),
            execution,
          ),
          (selected: any[]) => {
            if (selected.length === 0) return { cleaned: true, deletedPhotos: [] } as AiIntakeRetentionCleanupResult;
            const selectedIds = selected.map((row) => row.id as string);
            return then(
              rows(
                tx
                  .delete(txPhotoTable)
                  .where(and(eq(txPhotoTable.intakeId, intakeId), inArray(txPhotoTable.id, selectedIds)))
                  .returning({ id: txPhotoTable.id }),
                execution,
              ),
              (deletedRows: any[]) => {
                const deletedIds = new Set(deletedRows.map((row) => row.id as string));
                const matches = deletedRows.length === selectedIds.length && selectedIds.every((id) => deletedIds.has(id));
                if (!matches) {
                  throw new AiIntakePhotoDeleteIntegrityFailureError(
                    `Expected to delete exactly ${selectedIds.length} ai_intake_photos row(s) for intake retention cleanup but ${deletedRows.length} were affected`,
                  );
                }
                return {
                  cleaned: true,
                  deletedPhotos: selected.map((row) => ({ id: row.id as string, storageKey: row.storageKey as string })),
                } as AiIntakeRetentionCleanupResult;
              },
            );
          },
        );
      }) as Promise<AiIntakeRetentionCleanupResult>;
    },

    async existsStagedPhotoById(photoId: string): Promise<boolean> {
      const found = await db.select({ id: photoTable.id }).from(photoTable).where(eq(photoTable.id, photoId)).limit(1);
      return found.length > 0;
    },

    async existsStagedPhotoByStorageKey(storageKey: string): Promise<boolean> {
      const found = await db.select({ id: photoTable.id }).from(photoTable).where(eq(photoTable.storageKey, storageKey)).limit(1);
      return found.length > 0;
    },

    async existsProductPhotoByIdAndProductId(photoId: string, productId: string): Promise<boolean> {
      const found = await db
        .select({ id: productPhotoTable.id })
        .from(productPhotoTable)
        .where(and(eq(productPhotoTable.id, photoId), eq(productPhotoTable.productId, productId)))
        .limit(1);
      return found.length > 0;
    },

    async hasNonTerminalProductPhotoOutboxEvent(photoId: string): Promise<boolean> {
      const found = await db
        .select({ id: outboxTable.id })
        .from(outboxTable)
        .where(
          and(
            eq(outboxTable.aggregateType, "ProductPhoto"),
            eq(outboxTable.aggregateId, photoId),
            notInArray(outboxTable.status, [...TERMINAL_OUTBOX_STATUSES]),
          ),
        )
        .limit(1);
      return found.length > 0;
    },
  };
}
