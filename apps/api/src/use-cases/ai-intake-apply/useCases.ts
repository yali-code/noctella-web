import { randomUUID } from "node:crypto";
import { AiProductIntakeStatus, ProductStatus, type ProductType } from "@noctella/shared";
import {
  AiIntakeApplyIntakeNotOpenError,
  AiIntakeApplyPhotoSetStaleError,
  AiIntakeApplyProposalNotReadyError,
  AiIntakeApplyProposalVersionConflictError,
  AiIntakeApplyResultStateInvalidError,
  BadRequestError,
  NotFoundError,
} from "../../services/errors";
import { computePhotoSetFingerprint } from "../../ai-intake/photoSetFingerprint";
import { createProductSchema, type CreateProductInput } from "../../validation/product";
import { createProductWithInventoryInTransactionUseCase } from "../product-write/useCases";
import { categoryExistsInTransaction } from "../../repositories/product-write/drizzle";
import type { AiIntakeApplyTransactionCapability } from "../../services/aiIntakeApplyTransactionCapabilityForDb";

const CONFIRMED_DECISIONS: ReadonlySet<string> = new Set(["accepted", "edited"]);
const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));

/**
 * Sprint 94 correction: PostgreSQL `timestamp` columns (no `mode: "string"`)
 * return real Date instances at runtime - String(aDateInstance) produces the
 * Date's default toString() form, not an ISO string, so it would never equal
 * a client-supplied ISO expectedProposalUpdatedAt token. Matches the
 * established toReviewedField/toOptionalIsoString pattern already proven in
 * services/aiIntakeProposals.ts and services/aiProductIntakes.ts.
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface ApplyAiIntakeInput {
  intakeId: string;
  sku: string;
  categoryId: string;
  type: ProductType;
  /** Sprint 137: optional/nullable, matching baseProductSchema's own priceEur - a Draft Product
   * created via this "Save as Draft" path may likewise have no sale price yet. */
  priceEur?: number | null;
  stockQuantity?: number;
  expectedProposalUpdatedAt: string;
  actorId: string;
}

export interface ApplyAiIntakeResult {
  /** false for the idempotent already-Applied retry path - no new writes were performed. */
  created: boolean;
  productId: string;
}

interface ProductFieldsFromProposal {
  title: string;
  description?: string;
  keywords?: string[];
}

/**
 * Sprint 94: consumes only the durable, explicit final values already stored
 * by Sprint 93's field review - never reconstructs an Accepted value from the
 * mutable suggestion column, never consumes a Pending or Rejected value.
 * Title must be Accepted or Edited with a non-empty value, or apply is
 * rejected before any canonical write. Description/keywords may be
 * Pending/Rejected - they are simply omitted from the constructed Product
 * input in that case, matching canonical Product validation (both optional).
 */
function decideProductFieldsFromProposal(proposal: Record<string, any>): ProductFieldsFromProposal {
  const titleDecision = proposal.titleDecision as string;
  const titleValue = proposal.titleValue as string | null;
  if (!CONFIRMED_DECISIONS.has(titleDecision) || !titleValue || !titleValue.trim()) {
    throw new AiIntakeApplyProposalNotReadyError();
  }

  const fields: ProductFieldsFromProposal = { title: titleValue };

  const descriptionDecision = proposal.descriptionDecision as string;
  const descriptionValue = proposal.descriptionValue as string | null;
  if (CONFIRMED_DECISIONS.has(descriptionDecision)) {
    if (!descriptionValue || !descriptionValue.trim()) {
      throw new AiIntakeApplyProposalNotReadyError("The proposal's description is Accepted or Edited but has no valid stored value.");
    }
    fields.description = descriptionValue;
  }

  const keywordsDecision = proposal.keywordsDecision as string;
  const keywordsValue = proposal.keywordsValue as string | null;
  if (CONFIRMED_DECISIONS.has(keywordsDecision)) {
    const parsed = keywordsValue ? (JSON.parse(keywordsValue) as string[]) : null;
    if (!parsed || parsed.length === 0) {
      throw new AiIntakeApplyProposalNotReadyError("The proposal's keywords are Accepted or Edited but have no valid stored value.");
    }
    fields.keywords = parsed;
  }

  return fields;
}

/**
 * Sprint 94: the single authoritative Save as Draft transaction. Locks the
 * intake row first (capability.runWithLockedIntake), then performs every
 * validation and write from data read inside that same lock - never a
 * pre-lock read - closing the same class of TOCTOU races Sprint 93's
 * corrections closed for proposal/photo writes. An already-Applied intake is
 * handled as an idempotent no-write success (returns the existing
 * resultProductId); a Cancelled or otherwise non-Open intake is rejected.
 */
export async function applyAiIntakeUseCase(capability: AiIntakeApplyTransactionCapability, input: ApplyAiIntakeInput): Promise<ApplyAiIntakeResult> {
  return capability.runWithLockedIntake(input.intakeId, (ctx) => {
    const { intake } = ctx;
    if (!intake) throw new NotFoundError("AI product intake not found");

    if (intake.status === AiProductIntakeStatus.Applied) {
      if (!intake.resultProductId) {
        throw new AiIntakeApplyResultStateInvalidError("This intake is Applied but has no result Product recorded.");
      }
      return { created: false, productId: intake.resultProductId as string };
    }

    if (intake.status !== AiProductIntakeStatus.Open) {
      throw new AiIntakeApplyIntakeNotOpenError();
    }

    return chain(ctx.readProposal(), (proposal) => {
      if (!proposal) throw new NotFoundError("AI intake proposal not found");
      if (toIsoString(proposal.updatedAt as string | Date) !== input.expectedProposalUpdatedAt) {
        throw new AiIntakeApplyProposalVersionConflictError();
      }

      const productFields = decideProductFieldsFromProposal(proposal);

      return chain(ctx.readOrderedPhotoIds(), (photoIds) => {
        const currentFingerprint = computePhotoSetFingerprint(photoIds.map((id) => ({ id })));
        if (currentFingerprint !== proposal.photoSetFingerprint) {
          throw new AiIntakeApplyPhotoSetStaleError();
        }

        return chain(categoryExistsInTransaction(ctx.tx, ctx.schema, input.categoryId, ctx.execution), (categoryExists) => {
          if (!categoryExists) throw new BadRequestError(`Category "${input.categoryId}" does not exist`);
          const candidate: CreateProductInput = createProductSchema.parse({
            sku: input.sku,
            categoryId: input.categoryId,
            type: input.type,
            priceEur: input.priceEur,
            status: ProductStatus.Draft,
            // Sprint 138: mirrors the identical Stock Acceptance correction - an omitted quantity
            // must still supply an explicit 1 (never 0) downstream, so canonical Product/Inventory
            // creation initializes Inventory and the initial StockMovement exactly as before.
            stockQuantity: input.stockQuantity ?? 1,
            title: productFields.title,
            ...(productFields.description !== undefined ? { description: productFields.description } : {}),
            ...(productFields.keywords !== undefined ? { keywords: productFields.keywords } : {}),
          });

          const inventoryCtx = { clock: { now: () => new Date() }, idGenerator: { newId: () => randomUUID() } };
          const repositories = {
            productWriteRepositories: ctx.productWriteRepositories,
            inventoryRepositories: ctx.inventoryRepositories,
          } as Parameters<typeof createProductWithInventoryInTransactionUseCase>[0];

          return chain(createProductWithInventoryInTransactionUseCase(repositories, inventoryCtx, candidate), (createResult) => {
            const now = new Date().toISOString();
            return chain(
              ctx.applyIntake({
                resultProductId: createResult.id,
                appliedAt: now,
                appliedByAdminUserId: input.actorId,
                updatedAt: now,
              }),
              (finalizeResult) => {
                // Defensive only - the intake row is already locked for the whole transaction, so
                // this should never fail given the checks above already passed.
                if (!finalizeResult.updated) throw new AiIntakeApplyResultStateInvalidError();
                return { created: true, productId: createResult.id };
              },
            );
          });
        });
      });
    });
  });
}
