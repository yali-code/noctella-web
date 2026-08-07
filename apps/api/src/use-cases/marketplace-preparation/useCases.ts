import { randomUUID } from "node:crypto";
import { PublishChannel } from "@noctella/shared";
import {
  MarketplacePreparationGenerationInProgressError,
  MarketplacePreparationNotPendingError,
  MarketplacePreparationVersionConflictError,
  NotFoundError,
} from "../../services/errors";
import { releaseMarketplacePreparationGenerationGuard, tryAcquireMarketplacePreparationGenerationGuard } from "./generationGuard";
import { DeterministicMarketplacePreparationPromptBuilder } from "../../marketplace-prep/promptBuilder";
import type {
  MarketplacePreparationProductContext,
  MarketplacePreparationPromptBuilder,
  MarketplacePreparationProvider,
} from "../../marketplace-prep/types";
import type { MarketplacePreparationRecord, MarketplacePreparationRepository } from "../../repositories/marketplace-preparation/types";
import { updateProductWithInventoryInTransactionUseCase } from "../product-write/useCases";
import type { MarketplacePreparationApprovalTransactionCapability } from "../../services/marketplacePreparationApprovalTransactionCapabilityForDb";

const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));

/** PostgreSQL `timestamp` columns (no `mode: "string"`) return real Date instances at runtime - see the identical, already-proven pattern in use-cases/ai-intake-proposal/useCases.ts's nextUpdatedAt/toIsoString helpers. */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface GenerateMarketplacePreparationInput {
  productId: string;
  channel: PublishChannel;
  /** Captured from the same fresh Product read used to build `context`, before the provider is ever called - never re-read after generation. */
  baseProductUpdatedAt: string;
  context: MarketplacePreparationProductContext;
}

/**
 * Sprint 107: provider execution stays outside any database transaction -
 * mirrors generateOrRegenerateProposalUseCase's (use-cases/ai-intake-proposal/
 * useCases.ts) proven shape exactly. The guard (see ./generationGuard.ts) is
 * acquired synchronously and atomically before the provider call and held
 * through persistence, released in a finally block regardless of success or
 * failure - closing the exact duplicate-paid-call race Sprint 103 closed for
 * AI Intake, scoped here to (productId, channel) instead of intakeId.
 *
 * Generation always succeeds for a fresh (productId, channel) pair or
 * refreshes an existing one in place - there is no intake-style "must be
 * Open"/"all fields Pending" precondition in this domain (see
 * repositories/marketplace-preparation/types.ts's upsert doc comment).
 */
export async function generateMarketplacePreparationUseCase(
  repository: MarketplacePreparationRepository,
  provider: MarketplacePreparationProvider,
  input: GenerateMarketplacePreparationInput,
  promptBuilder: MarketplacePreparationPromptBuilder = new DeterministicMarketplacePreparationPromptBuilder(),
): Promise<MarketplacePreparationRecord> {
  if (!tryAcquireMarketplacePreparationGenerationGuard(input.productId, input.channel)) {
    throw new MarketplacePreparationGenerationInProgressError();
  }

  try {
    const prompt = promptBuilder.build(input.context);
    const result = await provider.generate({ context: input.context, prompt });
    const now = new Date().toISOString();

    return repository.upsert({
      id: randomUUID(),
      productId: input.productId,
      channel: input.channel,
      baseProductUpdatedAt: input.baseProductUpdatedAt,
      suggestedTitle: result.proposal.suggestedTitle ?? null,
      suggestedDescription: result.proposal.suggestedDescription ?? null,
      suggestedConditionDescription: result.proposal.suggestedConditionDescription ?? null,
      suggestedItemSpecifics: result.proposal.suggestedItemSpecifics ?? null,
      suggestedTags: result.proposal.suggestedTags ? JSON.stringify(result.proposal.suggestedTags) : null,
      suggestedMaterials: result.proposal.suggestedMaterials ?? null,
      suggestedStyle: result.proposal.suggestedStyle ?? null,
      suggestedOccasion: result.proposal.suggestedOccasion ?? null,
      suggestedShortDescription: result.proposal.suggestedShortDescription ?? null,
      suggestedSeoTitle: result.proposal.suggestedSeoTitle ?? null,
      suggestedMetaDescription: result.proposal.suggestedMetaDescription ?? null,
      suggestedFocusKeyword: result.proposal.suggestedFocusKeyword ?? null,
      providerName: result.metadata.providerName,
      promptVersion: result.metadata.promptVersion,
      generatedAt: now,
    });
  } finally {
    releaseMarketplacePreparationGenerationGuard(input.productId, input.channel);
  }
}

/**
 * Sprint 107: the admin-reviewed/edited final field values, submitted
 * directly as part of approval - mirrors Stock Acceptance's exact
 * established precedent (use-cases/ai-intake-stock-acceptance/useCases.ts):
 * the server never re-derives these from the stored proposal, it trusts
 * exactly what is submitted here. Only the fields relevant to `channel` are
 * ever read by approveMarketplacePreparationUseCase - the rest are ignored.
 */
export interface ApproveMarketplacePreparationFieldInput {
  title?: string;
  description?: string;
  conditionDescription?: string;
  itemSpecifics?: string;
  tags?: string[];
  materials?: string;
  style?: string;
  occasion?: string;
  shortDescription?: string;
  seoTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
}

export interface ApproveMarketplacePreparationInput extends ApproveMarketplacePreparationFieldInput {
  id: string;
  productId: string;
  channel: PublishChannel;
  expectedProposalUpdatedAt: string;
  actorId: string;
}

export interface ApproveMarketplacePreparationResult {
  productId: string;
}

/**
 * Sprint 107: maps the admin-approved field input onto the exact existing
 * Product marketplace-field columns for one channel - see Sprint 107's
 * approved field-ownership matrix. Never touches SKU, barcode, stock,
 * status, collectionId, purchase cost, internal notes, listing status,
 * external listing ids, or any other channel's fields. wooSlug is
 * deliberately never included here (per approved scope: AI/approval never
 * generates or changes it).
 */
function mapApprovedFieldsToProductValues(channel: PublishChannel, input: ApproveMarketplacePreparationFieldInput): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined) values[key] = value;
  };

  if (channel === PublishChannel.Ebay) {
    set("ebayTitle", input.title);
    set("ebayDescription", input.description);
    set("ebayConditionDescription", input.conditionDescription);
    set("ebayItemSpecifics", input.itemSpecifics);
  } else if (channel === PublishChannel.Etsy) {
    set("etsyTitle", input.title);
    set("etsyDescription", input.description);
    if (input.tags !== undefined) values.etsyTags = JSON.stringify(input.tags);
    set("etsyMaterials", input.materials);
    set("etsyStyle", input.style);
    set("etsyOccasion", input.occasion);
  } else {
    set("wooProductName", input.title);
    set("wooLongDescription", input.description);
    set("wooShortDescription", input.shortDescription);
    set("wooSeoTitle", input.seoTitle);
    set("wooMetaDescription", input.metaDescription);
    set("wooFocusKeyword", input.focusKeyword);
  }

  return values;
}

/**
 * Sprint 107: admin approval - one transaction containing the atomic
 * marketplace-preparation Pending claim, the Product freshness check (via
 * the existing updateWithExpectedVersion mechanism, expectedUpdatedAt =
 * the proposal's own durable baseProductUpdatedAt - never a new versioning
 * system, exactly mirroring approveAiListingDraftUseCase's proven Sprint 89
 * pattern), and the canonical transaction-scoped Product update - either
 * operation failing rolls back both. No external AI/provider/filesystem/
 * network call occurs anywhere in this function. Never touches Inventory -
 * `values` never includes stockQuantity.
 */
export async function approveMarketplacePreparationUseCase(
  capability: MarketplacePreparationApprovalTransactionCapability,
  input: ApproveMarketplacePreparationInput,
): Promise<ApproveMarketplacePreparationResult> {
  return capability.run((ctx) =>
    chain(ctx.marketplacePreparationApprovalRepository.findById(input.id), (proposal) => {
      if (!proposal) throw new NotFoundError("Marketplace preparation not found");
      if (proposal.status !== "pending") throw new MarketplacePreparationNotPendingError();
      if (toIsoString(proposal.updatedAt as string | Date) !== input.expectedProposalUpdatedAt) {
        throw new MarketplacePreparationVersionConflictError();
      }

      const values = mapApprovedFieldsToProductValues(input.channel, input);
      const baseProductUpdatedAt = toIsoString(proposal.baseProductUpdatedAt as string | Date);

      return chain(
        updateProductWithInventoryInTransactionUseCase(
          { productWriteRepositories: ctx.productWriteRepositories, inventoryRepositories: ctx.inventoryRepositories } as any,
          { clock: { now: () => new Date() }, idGenerator: { newId: () => randomUUID() } },
          {
            id: input.productId,
            values,
            expectedUpdatedAt: baseProductUpdatedAt,
            currentUpdatedAtForNextVersion: baseProductUpdatedAt,
            // Never changes stock/Inventory - stockQuantity stays undefined so
            // updateProductWithInventoryInTransactionUseCase's own undefined-check
            // short-circuits before touching Inventory.
          },
        ),
        () => {
          const now = new Date().toISOString();
          return chain(
            ctx.marketplacePreparationApprovalRepository.claimAndApprove({
              id: input.id,
              appliedAt: now,
              appliedByAdminUserId: input.actorId,
              updatedAt: now,
            }),
            (claim) => {
              // Defensive only - proposal.status was already verified Pending above, under the
              // same lock this atomic claim runs in, so this should never fail given the checks
              // above already passed.
              if (!claim.updated) throw new MarketplacePreparationNotPendingError();
              return { productId: input.productId };
            },
          );
        },
      );
    }),
  );
}
