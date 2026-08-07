import { and, asc, eq } from "drizzle-orm";
import { AiIntakeFieldDecision, AiProductIntakeStatus } from "@noctella/shared";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import { computePhotoSetFingerprint } from "../../ai-intake/photoSetFingerprint";
import type {
  AiIntakeProposalCreateInput,
  AiIntakeProposalField,
  AiIntakeProposalFieldReviewDecision,
  AiIntakeProposalRecord,
  AiIntakeProposalRefreshInput,
  AiIntakeProposalRepository,
  AiIntakeProposalWriteResult,
} from "./types";
import type { AiIntakeLockTransactionCapability } from "../../services/aiIntakeLockTransactionCapabilityForDb";

type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

// Mirrors repositories/ai-draft/drizzle.ts's exact then/rows/first/run helpers - proven safe
// across both the synchronous (better-sqlite3, inside a db.transaction callback) and
// asynchronous (postgres) execution modes. `run` mirrors
// repositories/product-write/drizzle.ts's convention for INSERT/UPDATE/DELETE statements
// executed without RETURNING inside a synchronous transaction.
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const first = (q: any, execution: Execution): Result<any> =>
  then(rows(q, execution), (values) => values[0] ?? null);

const PENDING = "pending";

/** PostgreSQL code 23505, or the established SQLite/better-sqlite3 message form (see services/erpCustomerBridge.ts). */
function isUniqueViolation(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return code === "23505" || message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint");
}

/** Reads the intake's current staged-photo ids in listIntakePhotos's canonical created_at ASC, id ASC order, from inside the caller's locked transaction. */
function readOrderedPhotoIds(tx: any, txSchema: Schema, intakeId: string, execution: Execution): Result<string[]> {
  const photoTable = (txSchema as Record<string, any>).aiIntakePhotos;
  return then(
    rows(tx.select({ id: photoTable.id }).from(photoTable).where(eq(photoTable.intakeId, intakeId)).orderBy(asc(photoTable.createdAt), asc(photoTable.id)), execution),
    (photoRows) => photoRows.map((row: any) => row.id as string),
  );
}

function currentPhotoFingerprint(tx: any, txSchema: Schema, intakeId: string, execution: Execution): Result<string> {
  return then(readOrderedPhotoIds(tx, txSchema, intakeId, execution), (ids) => computePhotoSetFingerprint(ids.map((id) => ({ id }))));
}

/**
 * Sprint 93 correction pass: every write locks the related ai_product_intakes
 * row (via capability.runWithLockedIntake) before touching ai_intake_proposals,
 * re-validates intake status and the photo-set fingerprint from data read
 * inside that same lock, and only then performs its write - closing both the
 * unlocked-read-then-insert race (first generation vs. cancellation) and the
 * service-only staleness pre-check TOCTOU (field review vs. a staged-photo
 * change) identified in the Sprint 93 Exact Review.
 */
export function createDrizzleAiIntakeProposalRepository(
  db: any,
  schema: Schema,
  capability: AiIntakeLockTransactionCapability,
): AiIntakeProposalRepository {
  const table = (schema as Record<string, any>).aiIntakeProposals;

  return {
    async findByIntakeId(intakeId: string): Promise<AiIntakeProposalRecord | null> {
      const [row] = await db.select().from(table).where(eq(table.intakeId, intakeId));
      return (row as AiIntakeProposalRecord) ?? null;
    },

    async insertIfAbsentAndIntakeOpen(input: AiIntakeProposalCreateInput): Promise<AiIntakeProposalWriteResult> {
      try {
        return await capability.runWithLockedIntake(input.intakeId, ({ tx, schema: txSchema, execution, intake }) => {
          const txProposalTable = (txSchema as Record<string, any>).aiIntakeProposals;

          if (!intake) return { updated: false, conflict: { reason: "intake_not_found" as const, message: "AI product intake not found" } };
          if (intake.status !== AiProductIntakeStatus.Open) {
            return { updated: false, conflict: { reason: "intake_not_open" as const, message: "AI product intake is not Open" } };
          }

          return then(currentPhotoFingerprint(tx, txSchema, input.intakeId, execution), (fingerprint) => {
            if (fingerprint !== input.expectedPhotoFingerprint) {
              return {
                updated: false,
                conflict: { reason: "photo_context_changed" as const, message: "The staged photos changed while the proposal was being generated. Regenerate the proposal." },
              };
            }
            return then(first(tx.select().from(txProposalTable).where(eq(txProposalTable.intakeId, input.intakeId)), execution), (existingProposal) => {
              if (existingProposal) {
                return {
                  updated: false,
                  conflict: { reason: "proposal_already_exists" as const, message: "A proposal already exists for this intake" },
                  row: existingProposal as AiIntakeProposalRecord,
                };
              }
              return then(
                rows(
                  tx
                    .insert(txProposalTable)
                    .values({
                      id: input.id,
                      intakeId: input.intakeId,
                      suggestedTitle: input.suggestedTitle,
                      suggestedDescription: input.suggestedDescription,
                      suggestedKeywords: input.suggestedKeywords,
                      confidenceScore: input.confidenceScore,
                      suggestedCategoryId: input.suggestedCategoryId,
                      suggestedBrand: input.suggestedBrand,
                      suggestedModel: input.suggestedModel,
                      suggestedManufacturer: input.suggestedManufacturer,
                      suggestedCountryOfOrigin: input.suggestedCountryOfOrigin,
                      suggestedPeriod: input.suggestedPeriod,
                      suggestedMaterials: input.suggestedMaterials,
                      suggestedCondition: input.suggestedCondition,
                      suggestedConditionDescription: input.suggestedConditionDescription,
                      suggestedSeoTitle: input.suggestedSeoTitle,
                      suggestedMetaDescription: input.suggestedMetaDescription,
                      suggestedPriceEur: input.suggestedPriceEur,
                      photoSetFingerprint: fingerprint,
                      generatedAt: input.generatedAt,
                      providerName: input.providerName,
                      promptVersion: input.promptVersion,
                      createdAt: input.createdAt,
                      updatedAt: input.updatedAt,
                    })
                    .returning(),
                  execution,
                ),
                (inserted: any[]) => ({ updated: true, row: inserted[0] as AiIntakeProposalRecord }),
              );
            });
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { updated: false, conflict: { reason: "proposal_already_exists", message: "A proposal already exists for this intake" } };
        }
        throw err;
      }
    },

    async refreshPendingFields(input: AiIntakeProposalRefreshInput): Promise<AiIntakeProposalWriteResult> {
      return capability.runWithLockedIntake(input.intakeId, ({ tx, schema: txSchema, execution, intake }) => {
        const txProposalTable = (txSchema as Record<string, any>).aiIntakeProposals;

        if (!intake) return { updated: false, conflict: { reason: "intake_not_found" as const, message: "AI product intake not found" } };
        if (intake.status !== AiProductIntakeStatus.Open) {
          return { updated: false, conflict: { reason: "intake_not_open" as const, message: "AI product intake is not Open" } };
        }

        return then(currentPhotoFingerprint(tx, txSchema, input.intakeId, execution), (fingerprint) => {
          if (fingerprint !== input.expectedPhotoFingerprint) {
            return {
              updated: false,
              conflict: { reason: "photo_context_changed" as const, message: "The staged photos changed while the proposal was being regenerated. Try again." },
            };
          }
          return then(first(tx.select().from(txProposalTable).where(eq(txProposalTable.id, input.id)), execution), (existing) => {
            if (!existing) return { updated: false, conflict: { reason: "version_mismatch" as const, message: "AI intake proposal not found" } };
            const allPending = existing.titleDecision === PENDING && existing.descriptionDecision === PENDING && existing.keywordsDecision === PENDING;
            if (!allPending) {
              return {
                updated: false,
                conflict: { reason: "review_not_pending" as const, message: "Reset all reviewed fields to pending before regenerating the proposal." },
                row: existing as AiIntakeProposalRecord,
              };
            }
            if (String(existing.updatedAt) !== input.expectedUpdatedAt) {
              return {
                updated: false,
                conflict: { reason: "version_mismatch" as const, message: "This proposal changed before the operation completed." },
                row: existing as AiIntakeProposalRecord,
              };
            }
            return then(
              rows(
                tx
                  .update(txProposalTable)
                  .set({
                    suggestedTitle: input.suggestedTitle,
                    suggestedDescription: input.suggestedDescription,
                    suggestedKeywords: input.suggestedKeywords,
                    confidenceScore: input.confidenceScore,
                    suggestedCategoryId: input.suggestedCategoryId,
                    suggestedBrand: input.suggestedBrand,
                    suggestedModel: input.suggestedModel,
                    suggestedManufacturer: input.suggestedManufacturer,
                    suggestedCountryOfOrigin: input.suggestedCountryOfOrigin,
                    suggestedPeriod: input.suggestedPeriod,
                    suggestedMaterials: input.suggestedMaterials,
                    suggestedCondition: input.suggestedCondition,
                    suggestedConditionDescription: input.suggestedConditionDescription,
                    suggestedSeoTitle: input.suggestedSeoTitle,
                    suggestedMetaDescription: input.suggestedMetaDescription,
                    suggestedPriceEur: input.suggestedPriceEur,
                    photoSetFingerprint: fingerprint,
                    generatedAt: input.generatedAt,
                    providerName: input.providerName,
                    promptVersion: input.promptVersion,
                    updatedAt: input.updatedAt,
                  })
                  .where(eq(txProposalTable.id, input.id))
                  .returning(),
                execution,
              ),
              (updated: any[]) => ({ updated: true, row: updated[0] as AiIntakeProposalRecord }),
            );
          });
        });
      });
    },

    async updateFieldReviewAtomic(
      intakeId: string,
      proposalId: string,
      field: AiIntakeProposalField,
      expectedUpdatedAt: string,
      requestedDecision: AiIntakeFieldDecision,
      decide: (existing: AiIntakeProposalRecord) => AiIntakeProposalFieldReviewDecision,
    ): Promise<AiIntakeProposalWriteResult> {
      return capability.runWithLockedIntake(intakeId, ({ tx, schema: txSchema, execution, intake }) => {
        const txProposalTable = (txSchema as Record<string, any>).aiIntakeProposals;

        if (!intake) return { updated: false, conflict: { reason: "intake_not_found" as const, message: "AI product intake not found" } };
        if (intake.status !== AiProductIntakeStatus.Open) {
          return { updated: false, conflict: { reason: "intake_not_open" as const, message: "AI product intake is not Open" } };
        }

        return then(first(tx.select().from(txProposalTable).where(eq(txProposalTable.id, proposalId)), execution), (existing) => {
          if (!existing) return { updated: false, conflict: { reason: "version_mismatch" as const, message: "AI intake proposal not found" } };
          if (String(existing.updatedAt) !== expectedUpdatedAt) {
            return {
              updated: false,
              conflict: { reason: "version_mismatch" as const, message: "This proposal changed before the operation completed." },
              row: existing as AiIntakeProposalRecord,
            };
          }
          return then(currentPhotoFingerprint(tx, txSchema, intakeId, execution), (fingerprint) => {
            const isStale = fingerprint !== existing.photoSetFingerprint;
            // Sprint 97: the only exception to fingerprint-staleness rejection - a Pending reset is
            // always allowed even while stale, since it is the sole way a stale proposal recovers
            // (regeneration itself requires every field to already be Pending). Accepted/Edited/
            // Rejected remain fully blocked while stale, exactly as before.
            if (isStale && requestedDecision !== AiIntakeFieldDecision.Pending) {
              return { updated: false, conflict: { reason: "photo_context_changed" as const, message: "The staged photos changed after this proposal was generated." } };
            }

            // decide() may throw (e.g. AiIntakeProposalSuggestionUnavailableError) - the throw
            // propagates out of the transaction (rolling it back) and out of this method, exactly
            // like a driver error, since no local try/catch here swallows it.
            const decision = decide(existing as AiIntakeProposalRecord);
            if (decision.decision !== requestedDecision) {
              // Defensive invariant only - decide() is always built from the same input.decision
              // the caller already passed as requestedDecision, so this should never diverge. A
              // fixed, non-sensitive message avoids leaking any caller-derived detail.
              throw new Error("AI intake proposal field review decision mismatch");
            }
            const columns: Record<AiIntakeProposalField, { decision: string; value: string; reviewedBy: string; reviewedAt: string }> = {
              title: { decision: "titleDecision", value: "titleValue", reviewedBy: "titleReviewedByAdminUserId", reviewedAt: "titleReviewedAt" },
              description: { decision: "descriptionDecision", value: "descriptionValue", reviewedBy: "descriptionReviewedByAdminUserId", reviewedAt: "descriptionReviewedAt" },
              keywords: { decision: "keywordsDecision", value: "keywordsValue", reviewedBy: "keywordsReviewedByAdminUserId", reviewedAt: "keywordsReviewedAt" },
            };
            const fieldColumns = columns[field];

            return then(
              rows(
                tx
                  .update(txProposalTable)
                  .set({
                    [fieldColumns.decision]: decision.decision,
                    [fieldColumns.value]: decision.value,
                    [fieldColumns.reviewedBy]: decision.reviewedByAdminUserId,
                    [fieldColumns.reviewedAt]: decision.reviewedAt,
                    updatedAt: decision.updatedAt,
                  })
                  .where(and(eq(txProposalTable.id, proposalId), eq(txProposalTable.intakeId, intakeId)))
                  .returning(),
                execution,
              ),
              (updated: any[]) => ({ updated: true, row: updated[0] as AiIntakeProposalRecord }),
            );
          });
        });
      });
    },
  };
}
