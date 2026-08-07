import { PublishChannel, type MarketplacePreparation, type Product } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getProductById } from "./products";
import { NotFoundError } from "./errors";
import { buildMarketplacePreparationContext } from "../marketplace-prep/context";
import { createMarketplacePreparationProvider } from "../marketplace-prep/providerFactory";
import type { MarketplacePreparationProvider } from "../marketplace-prep/types";
import { createDrizzleMarketplacePreparationRepository } from "../repositories/marketplace-preparation/drizzle";
import type { MarketplacePreparationRecord } from "../repositories/marketplace-preparation/types";
import { approveMarketplacePreparationUseCase, generateMarketplacePreparationUseCase, type ApproveMarketplacePreparationFieldInput } from "../use-cases/marketplace-preparation/useCases";
import { createMarketplacePreparationApprovalTransactionCapabilityForDb, type MarketplacePreparationApprovalTransactionDriver } from "./marketplacePreparationApprovalTransactionCapabilityForDb";

function toIsoString(value: string | number | boolean | Date | null): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function toOptionalIsoString(value: string | number | boolean | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** Mirrors services/aiIntakeProposals.ts's toProposalReview - the shared row-to-response mapper used by every read path (generate, get, and - indirectly, via the same repository - approve's pre-check). */
function toMarketplacePreparationReview(row: MarketplacePreparationRecord): MarketplacePreparation {
  return {
    id: row.id as string,
    productId: row.productId as string,
    channel: row.channel as PublishChannel,
    status: row.status as MarketplacePreparation["status"],
    baseProductUpdatedAt: toIsoString(row.baseProductUpdatedAt),
    suggestedTitle: toOptionalString(row.suggestedTitle),
    suggestedDescription: toOptionalString(row.suggestedDescription),
    suggestedConditionDescription: toOptionalString(row.suggestedConditionDescription),
    suggestedItemSpecifics: toOptionalString(row.suggestedItemSpecifics),
    suggestedTags: row.suggestedTags ? (JSON.parse(row.suggestedTags as string) as string[]) : undefined,
    suggestedMaterials: toOptionalString(row.suggestedMaterials),
    suggestedStyle: toOptionalString(row.suggestedStyle),
    suggestedOccasion: toOptionalString(row.suggestedOccasion),
    suggestedShortDescription: toOptionalString(row.suggestedShortDescription),
    suggestedSeoTitle: toOptionalString(row.suggestedSeoTitle),
    suggestedMetaDescription: toOptionalString(row.suggestedMetaDescription),
    suggestedFocusKeyword: toOptionalString(row.suggestedFocusKeyword),
    providerName: row.providerName as string,
    promptVersion: row.promptVersion as string,
    generatedAt: toIsoString(row.generatedAt),
    appliedAt: toOptionalIsoString(row.appliedAt as string | Date | null),
    appliedByAdminUserId: toOptionalString(row.appliedByAdminUserId),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

/**
 * Sprint 107: generates (or regenerates, always refreshing in place - see
 * repositories/marketplace-preparation/types.ts's upsert doc comment) a
 * marketplace-preparation proposal for one Product+channel. Always reads
 * the canonical Product fresh (getProductById) - never staged AI Intake
 * data, which this file has no import path to reach. The provider default
 * is env-driven (marketplace-prep/providerFactory.ts,
 * MARKETPLACE_PREP_PROVIDER=mock|openai, defaulting to Mock), evaluated
 * fresh on every call that omits the `provider` argument - mirrors
 * services/aiIntakeGeneration.ts's exact convention.
 */
export async function generateMarketplacePreparation(
  db: DbClient,
  productId: string,
  channel: PublishChannel,
  provider: MarketplacePreparationProvider = createMarketplacePreparationProvider(),
): Promise<MarketplacePreparation> {
  const product: Product = await getProductById(db, productId); // throws NotFoundError if missing
  const context = buildMarketplacePreparationContext(product, channel);
  const repository = createDrizzleMarketplacePreparationRepository(db);

  const row = await generateMarketplacePreparationUseCase(repository, provider, {
    productId,
    channel,
    baseProductUpdatedAt: product.updatedAt,
    context,
  });
  return toMarketplacePreparationReview(row);
}

export async function getCurrentMarketplacePreparation(db: DbClient, productId: string, channel: PublishChannel): Promise<MarketplacePreparation> {
  const repository = createDrizzleMarketplacePreparationRepository(db);
  const row = await repository.findByProductIdAndChannel(productId, channel);
  if (!row) throw new NotFoundError("Marketplace preparation not found");
  return toMarketplacePreparationReview(row);
}

export interface ApproveMarketplacePreparationServiceInput extends ApproveMarketplacePreparationFieldInput {
  channel: PublishChannel;
  expectedProposalUpdatedAt: string;
}

/**
 * Sprint 107: mirrors services/aiDrafts.ts's approveDraft / services/
 * aiIntakeStockAcceptance.ts's acceptAiIntakeIntoStock exact split - a fast
 * pre-check (resolve productId+channel -> the proposal's own id) outside
 * any transaction, then the atomic claim + Product write inside one
 * transaction (approveMarketplacePreparationUseCase). Returns the current
 * canonical Product (unchanged fields aside from the one approved channel's
 * columns) - never publishes, never creates a PublishJob/PublishAttempt/
 * ExternalListing, never changes Product.status or any listing status.
 */
export async function approveMarketplacePreparation(
  db: DbClient,
  productId: string,
  input: ApproveMarketplacePreparationServiceInput,
  actorId: string,
): Promise<Product> {
  const repository = createDrizzleMarketplacePreparationRepository(db);
  const existing = await repository.findByProductIdAndChannel(productId, input.channel);
  if (!existing) throw new NotFoundError("Marketplace preparation not found");

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as MarketplacePreparationApprovalTransactionDriver;
  const capability = createMarketplacePreparationApprovalTransactionCapabilityForDb(db, driver);

  await approveMarketplacePreparationUseCase(capability, {
    id: existing.id as string,
    productId,
    channel: input.channel,
    expectedProposalUpdatedAt: input.expectedProposalUpdatedAt,
    actorId,
    title: input.title,
    description: input.description,
    conditionDescription: input.conditionDescription,
    itemSpecifics: input.itemSpecifics,
    tags: input.tags,
    materials: input.materials,
    style: input.style,
    occasion: input.occasion,
    shortDescription: input.shortDescription,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    focusKeyword: input.focusKeyword,
  });

  return getProductById(db, productId);
}
