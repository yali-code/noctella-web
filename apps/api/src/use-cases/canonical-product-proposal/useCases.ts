import { randomUUID } from "node:crypto";
import { CANONICAL_PHYSICAL_FIELD_KEYS, CANONICAL_PRODUCT_DETAIL_FIELD_KEYS } from "@noctella/shared";
import {
  CanonicalProductProposalGenerationInProgressError,
  CanonicalProductProposalNoSelectionError,
  CanonicalProductProposalNotPendingError,
  CanonicalProductProposalVersionConflictError,
  NotFoundError,
} from "../../services/errors";
import { releaseCanonicalProductProposalGenerationGuard, tryAcquireCanonicalProductProposalGenerationGuard } from "./generationGuard";
import { DeterministicCanonicalProductProposalPromptBuilder } from "../../canonical-product-ai/promptBuilder";
import type {
  CanonicalProductPhotoReader,
  CanonicalProductProposalContext,
  CanonicalProductProposalPromptBuilder,
  CanonicalProductProposalProvider,
} from "../../canonical-product-ai/types";
import type { CanonicalProductProposalRecord, CanonicalProductProposalRepository } from "../../repositories/canonical-product-proposal/types";
import type { TransactionalMarketingTagWriteRepository } from "../../repositories/marketing-tags/transactionalDrizzle";
import { canonicalizeMarketingTagKey } from "../../services/marketingTags";
import { updateProductWithInventoryInTransactionUseCase } from "../product-write/useCases";
import type { CanonicalProductProposalApprovalTransactionCapability } from "../../services/canonicalProductProposalApprovalTransactionCapabilityForDb";

const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));

/** PostgreSQL `timestamp` columns (no `mode: "string"`) return real Date instances at runtime - see the identical, already-proven pattern in use-cases/marketplace-preparation/useCases.ts's toIsoString helper. */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface GenerateCanonicalProductProposalInput {
  productId: string;
  /** Captured from the same fresh Product read used to build `context`, before the provider is ever called - never re-read after generation. */
  baseProductUpdatedAt: string;
  context: CanonicalProductProposalContext;
  photoReader: CanonicalProductPhotoReader;
}

/**
 * Sprint 148: mirrors generateMarketplacePreparationUseCase's proven shape exactly - provider
 * execution stays outside any database transaction, the guard is acquired synchronously and
 * atomically before the provider call and released in a finally block regardless of outcome.
 * Generate NEVER writes to Product or Marketing Tags - only ever upserts the isolated proposal
 * row. A regenerated proposal always gets a fresh `updatedAt` (see repository upsert's doc
 * comment), which is exactly what prevents an older client from Accepting a stale proposal.
 */
export async function generateCanonicalProductProposalUseCase(
  repository: CanonicalProductProposalRepository,
  provider: CanonicalProductProposalProvider,
  input: GenerateCanonicalProductProposalInput,
  promptBuilder: CanonicalProductProposalPromptBuilder = new DeterministicCanonicalProductProposalPromptBuilder(),
): Promise<CanonicalProductProposalRecord> {
  if (!tryAcquireCanonicalProductProposalGenerationGuard(input.productId)) {
    throw new CanonicalProductProposalGenerationInProgressError();
  }

  try {
    const prompt = promptBuilder.build(input.context);
    const result = await provider.generate({ context: input.context, prompt, photoReader: input.photoReader });
    const now = new Date().toISOString();

    return repository.upsert({
      id: randomUUID(),
      productId: input.productId,
      baseProductUpdatedAt: input.baseProductUpdatedAt,
      suggestedBrand: result.proposal.suggestedBrand ?? null,
      suggestedModel: result.proposal.suggestedModel ?? null,
      suggestedManufacturer: result.proposal.suggestedManufacturer ?? null,
      suggestedCountryOfOrigin: result.proposal.suggestedCountryOfOrigin ?? null,
      suggestedPeriod: result.proposal.suggestedPeriod ?? null,
      suggestedMaterials: result.proposal.suggestedMaterials ?? null,
      suggestedDescription: result.proposal.suggestedDescription ?? null,
      suggestedProductStory: result.proposal.suggestedProductStory ?? null,
      suggestedCondition: result.proposal.suggestedCondition ?? null,
      suggestedConditionDescription: result.proposal.suggestedConditionDescription ?? null,
      suggestedLengthValue: result.proposal.suggestedLengthValue ?? null,
      suggestedWidthValue: result.proposal.suggestedWidthValue ?? null,
      suggestedHeightValue: result.proposal.suggestedHeightValue ?? null,
      suggestedDimensionUnit: result.proposal.suggestedDimensionUnit ?? null,
      suggestedWeightValue: result.proposal.suggestedWeightValue ?? null,
      suggestedWeightUnit: result.proposal.suggestedWeightUnit ?? null,
      suggestedMarketingTags: result.proposal.suggestedMarketingTags ? JSON.stringify(result.proposal.suggestedMarketingTags) : null,
      providerName: result.metadata.providerName,
      promptVersion: result.metadata.promptVersion,
      generatedAt: now,
    });
  } finally {
    releaseCanonicalProductProposalGenerationGuard(input.productId);
  }
}

const ALLOWED_PRODUCT_FIELD_KEYS = new Set<string>([...CANONICAL_PRODUCT_DETAIL_FIELD_KEYS, ...CANONICAL_PHYSICAL_FIELD_KEYS]);
const NUMERIC_FIELD_KEYS = new Set(["lengthValue", "widthValue", "heightValue", "weightValue"]);

function suggestedColumnFor(key: string): string {
  return `suggested${key[0].toUpperCase()}${key.slice(1)}`;
}

/**
 * Sprint 148: Architecture Review item J - server-side allowlist. `selected` has already been
 * restricted to CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS by the Zod request schema
 * (validation/canonicalProductProposal.ts), but this intersects against the allowlist again here
 * (defense in depth, never trust arbitrary client field names past the boundary alone) and only
 * ever reads the corresponding `suggested*` column off the already-loaded proposal row - never
 * anything the client submitted. A selected field the proposal has no suggestion for (null/absent)
 * is silently skipped - selecting an unavailable suggestion is a safe no-op, not an error.
 */
function mapSelectedFieldsToProductValues(proposalRow: CanonicalProductProposalRecord, selected: readonly string[]): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const key of selected) {
    if (!ALLOWED_PRODUCT_FIELD_KEYS.has(key)) continue;
    const raw = (proposalRow as Record<string, unknown>)[suggestedColumnFor(key)];
    if (raw === null || raw === undefined) continue;
    if (NUMERIC_FIELD_KEYS.has(key)) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(n)) values[key] = n;
    } else {
      values[key] = String(raw);
    }
  }
  return values;
}

/**
 * Sprint 148: sequentially find-or-creates + relates each selected Marketing Tag label, using the
 * `chain` helper so the exact same code path works synchronously (SQLite) or asynchronously
 * (Postgres) without a separate implementation. An unusable label (canonicalizes to an empty key)
 * is silently skipped rather than failing the whole Accept, mirroring
 * applyAiSuggestedMarketingTagsIfProductHasNone's own established tolerance.
 */
function applyMarketingTagsSequentially<T>(
  repo: TransactionalMarketingTagWriteRepository,
  labels: string[],
  productId: string,
  index: number,
  onDone: () => T | Promise<T>,
): T | Promise<T> {
  if (index >= labels.length) return onDone();
  const label = labels[index];
  const key = canonicalizeMarketingTagKey(label);
  if (!key) return applyMarketingTagsSequentially(repo, labels, productId, index + 1, onDone);
  return chain(repo.findOrCreateByKey(key, label), (tag) =>
    chain(repo.addRelation(productId, tag.id), () => applyMarketingTagsSequentially(repo, labels, productId, index + 1, onDone)),
  );
}

export interface AcceptCanonicalProductProposalInput {
  id: string;
  productId: string;
  expectedProposalUpdatedAt: string;
  actorId: string;
  /** Already restricted to CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS by the Zod request schema. */
  selectedProductFields: string[];
  /** Must be a subset of the proposal's own stored suggestedMarketingTags - enforced below, never trusted verbatim from the client. */
  selectedMarketingTags: string[];
}

export interface AcceptCanonicalProductProposalResult {
  productId: string;
}

/**
 * Sprint 148: one transaction containing the atomic proposal Pending claim, the proposal
 * freshness check, the Product optimistic-concurrency check (via the existing
 * updateWithExpectedVersion mechanism, expectedUpdatedAt = the proposal's own durable
 * baseProductUpdatedAt - never a new versioning system, mirroring
 * approveMarketplacePreparationUseCase's proven Sprint 107 pattern), the selective partial
 * Product update, and the additive Marketing Tag relations - either operation failing rolls back
 * all of it (Architecture Review item L: never Product-applied-but-tags-failed or the reverse
 * while marking the proposal Applied). No external AI/provider/filesystem/network call occurs
 * anywhere in this function. Never touches Inventory - `values` never includes stockQuantity.
 */
export async function acceptCanonicalProductProposalUseCase(
  capability: CanonicalProductProposalApprovalTransactionCapability,
  input: AcceptCanonicalProductProposalInput,
): Promise<AcceptCanonicalProductProposalResult> {
  if (input.selectedProductFields.length === 0 && input.selectedMarketingTags.length === 0) {
    throw new CanonicalProductProposalNoSelectionError();
  }

  return capability.run((ctx) =>
    chain(ctx.canonicalProductProposalApprovalRepository.findById(input.id), (proposal) => {
      if (!proposal) throw new NotFoundError("Canonical product AI proposal not found");
      if (proposal.status !== "pending") throw new CanonicalProductProposalNotPendingError();
      if (toIsoString(proposal.updatedAt as string | Date) !== input.expectedProposalUpdatedAt) {
        throw new CanonicalProductProposalVersionConflictError();
      }

      const productValues = mapSelectedFieldsToProductValues(proposal, input.selectedProductFields);
      const baseProductUpdatedAt = toIsoString(proposal.baseProductUpdatedAt as string | Date);
      const proposalTags: string[] = proposal.suggestedMarketingTags ? JSON.parse(proposal.suggestedMarketingTags as string) : [];
      const tagsToAdd = input.selectedMarketingTags.filter((label) => proposalTags.includes(label));

      return chain(
        updateProductWithInventoryInTransactionUseCase(
          { productWriteRepositories: ctx.productWriteRepositories, inventoryRepositories: ctx.inventoryRepositories } as any,
          { clock: { now: () => new Date() }, idGenerator: { newId: () => randomUUID() } },
          {
            id: input.productId,
            values: productValues,
            expectedUpdatedAt: baseProductUpdatedAt,
            currentUpdatedAtForNextVersion: baseProductUpdatedAt,
            // Never changes stock/Inventory - stockQuantity is never part of `values`.
          },
        ),
        () =>
          applyMarketingTagsSequentially(ctx.marketingTagWriteRepository, tagsToAdd, input.productId, 0, () => {
            const now = new Date().toISOString();
            return chain(
              ctx.canonicalProductProposalApprovalRepository.claimAndApply({
                id: input.id,
                appliedAt: now,
                appliedByAdminUserId: input.actorId,
                updatedAt: now,
              }),
              (claim) => {
                // Defensive only - proposal.status was already verified Pending above, under the
                // same lock this atomic claim runs in, so this should never fail given the checks
                // above already passed.
                if (!claim.updated) throw new CanonicalProductProposalNotPendingError();
                return { productId: input.productId };
              },
            );
          }),
      );
    }),
  );
}
