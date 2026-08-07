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
import { allocateNextProductSkuInTransaction, categoryExistsInTransaction } from "../../repositories/product-write/drizzle";
import type { AiIntakeApplyTransactionCapability } from "../../services/aiIntakeApplyTransactionCapabilityForDb";

const CONFIRMED_DECISIONS: ReadonlySet<string> = new Set(["accepted", "edited"]);
const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));

/**
 * Sprint 106 (Sprint 94's exact toIsoString, duplicated locally rather than
 * exported/imported - a five-line helper, not worth widening
 * use-cases/ai-intake-apply/useCases.ts's approved change surface for).
 * PostgreSQL `timestamp` columns (no `mode: "string"`) return real Date
 * instances at runtime - String(aDateInstance) produces the Date's default
 * toString() form, not an ISO string, so it would never equal a
 * client-supplied ISO expectedProposalUpdatedAt token.
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Sprint 106: the admin-reviewed/edited AI Full Product Analysis field
 * values, submitted directly as part of Stock Acceptance - mirrors how
 * categoryId/type/priceEur/stockQuantity already work in the existing Save
 * as Draft contract (use-cases/ai-intake-apply/useCases.ts). The server
 * never re-derives these from the stored proposal; it trusts exactly what is
 * submitted here. `sku` is deliberately absent - it is always
 * system-generated (see allocateNextProductSkuInTransaction).
 */
export interface StockAcceptanceFieldInput {
  categoryId: string;
  type: ProductType;
  priceEur: number;
  stockQuantity?: number;
  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  condition?: string;
  conditionDescription?: string;
  seoTitle?: string;
  metaDescription?: string;
}

export interface StockAcceptanceInput extends StockAcceptanceFieldInput {
  intakeId: string;
  expectedProposalUpdatedAt: string;
  actorId: string;
}

export interface StockAcceptanceResult {
  /** false for the idempotent already-Applied retry path - no new writes were performed, no SKU allocated. */
  created: boolean;
  productId: string;
}

interface ProductTextFieldsFromProposal {
  title: string;
  description?: string;
  keywords?: string[];
}

/**
 * Sprint 106 (mirrors use-cases/ai-intake-apply/useCases.ts's
 * decideProductFieldsFromProposal exactly, duplicated locally per the same
 * "not worth widening that file's approved change surface for a five-line
 * helper" reasoning as toIsoString above): consumes only the durable,
 * explicit final values already stored by Sprint 93's field review - never
 * reconstructs an Accepted value from the mutable suggestion column, never
 * consumes a Pending or Rejected value. Title must be Accepted or Edited
 * with a non-empty value, or Stock Acceptance is rejected before any
 * canonical write.
 */
function decideProductTextFieldsFromProposal(proposal: Record<string, any>): ProductTextFieldsFromProposal {
  const titleDecision = proposal.titleDecision as string;
  const titleValue = proposal.titleValue as string | null;
  if (!CONFIRMED_DECISIONS.has(titleDecision) || !titleValue || !titleValue.trim()) {
    throw new AiIntakeApplyProposalNotReadyError();
  }

  const fields: ProductTextFieldsFromProposal = { title: titleValue };

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
 * Sprint 106: Stock Acceptance - the approved Option B architecture. A thin
 * orchestration layer that REUSES, unchanged, every existing proven
 * primitive: the same AiIntakeApplyTransactionCapability/runWithLockedIntake
 * locking contract, the same proposal-version-conflict check, the same
 * photo-set-fingerprint staleness check, the same categoryExistsInTransaction
 * validation, and the same canonical createProductWithInventoryInTransactionUseCase
 * Product+Inventory write - all identical to
 * use-cases/ai-intake-apply/useCases.ts's applyAiIntakeUseCase, which remains
 * completely untouched. The only genuinely new logic is isolated to two
 * small units: decideProductTextFieldsFromProposal above (still reused
 * conceptually from the same title/description/keywords rule, duplicated
 * only because that file's own function is not exported) and
 * allocateNextProductSkuInTransaction (the system SKU generator).
 *
 * Transaction boundary: identical to applyAiIntakeUseCase - one locked
 * transaction covers intake re-read, proposal-version check, photo-fingerprint
 * check, category-existence check, SKU allocation, canonical Product+Inventory
 * creation, and marking the intake Applied. No external AI/provider/
 * filesystem/network call occurs anywhere in this function - image analysis
 * already happened, and was already persisted as the proposal, before Stock
 * Acceptance is ever invoked.
 *
 * Idempotency: an already-Applied intake returns its existing resultProductId
 * with no new write and no new SKU allocation - identical guarantee to
 * applyAiIntakeUseCase.
 */
export async function stockAcceptanceUseCase(capability: AiIntakeApplyTransactionCapability, input: StockAcceptanceInput): Promise<StockAcceptanceResult> {
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

      const textFields = decideProductTextFieldsFromProposal(proposal);

      return chain(ctx.readOrderedPhotoIds(), (photoIds) => {
        const currentFingerprint = computePhotoSetFingerprint(photoIds.map((id) => ({ id })));
        if (currentFingerprint !== proposal.photoSetFingerprint) {
          throw new AiIntakeApplyPhotoSetStaleError();
        }

        return chain(categoryExistsInTransaction(ctx.tx, ctx.schema, input.categoryId, ctx.execution), (categoryExists) => {
          if (!categoryExists) throw new BadRequestError(`Category "${input.categoryId}" does not exist`);

          return chain(allocateNextProductSkuInTransaction(ctx.tx, ctx.schema, ctx.execution), (sku) => {
            const candidate: CreateProductInput = createProductSchema.parse({
              sku,
              categoryId: input.categoryId,
              type: input.type,
              priceEur: input.priceEur,
              status: ProductStatus.Draft,
              stockQuantity: input.stockQuantity ?? 0,
              title: textFields.title,
              ...(textFields.description !== undefined ? { description: textFields.description } : {}),
              ...(textFields.keywords !== undefined ? { keywords: textFields.keywords } : {}),
              ...(input.brand !== undefined ? { brand: input.brand } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.manufacturer !== undefined ? { manufacturer: input.manufacturer } : {}),
              ...(input.countryOfOrigin !== undefined ? { countryOfOrigin: input.countryOfOrigin } : {}),
              ...(input.period !== undefined ? { period: input.period } : {}),
              ...(input.materials !== undefined ? { materials: input.materials } : {}),
              ...(input.condition !== undefined ? { condition: input.condition } : {}),
              ...(input.conditionDescription !== undefined ? { conditionDescription: input.conditionDescription } : {}),
              ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
              ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
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
  });
}
