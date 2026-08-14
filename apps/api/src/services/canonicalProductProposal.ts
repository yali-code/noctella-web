import type { CanonicalProductProposal, Product } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getProductById } from "./products";
import { getCategoryById } from "./categories";
import { listProductMarketingTags } from "./marketingTags";
import { NotFoundError } from "./errors";
import { buildCanonicalProductProposalContext, orderAndCapCanonicalProductPhotos } from "../canonical-product-ai/context";
import { LocalCanonicalProductPhotoReader } from "../canonical-product-ai/photoReader";
import { createCanonicalProductProposalProvider, readCanonicalProductAiMaxPhotos } from "../canonical-product-ai/providerFactory";
import type { CanonicalProductProposalProvider } from "../canonical-product-ai/types";
import { createDrizzleCanonicalProductProposalRepository } from "../repositories/canonical-product-proposal/drizzle";
import type { CanonicalProductProposalRecord } from "../repositories/canonical-product-proposal/types";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import {
  acceptCanonicalProductProposalUseCase,
  generateCanonicalProductProposalUseCase,
  type AcceptCanonicalProductProposalInput,
} from "../use-cases/canonical-product-proposal/useCases";
import { createCanonicalProductProposalApprovalTransactionCapabilityForDb, type CanonicalProductProposalApprovalTransactionDriver } from "./canonicalProductProposalApprovalTransactionCapabilityForDb";

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
function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Mirrors services/marketplacePreparation.ts's toMarketplacePreparationReview - the shared row-to-response mapper used by every read path (generate, get, and - indirectly, via the same repository - accept's pre-check). */
function toCanonicalProductProposalReview(row: CanonicalProductProposalRecord): CanonicalProductProposal {
  return {
    id: row.id as string,
    productId: row.productId as string,
    status: row.status as CanonicalProductProposal["status"],
    baseProductUpdatedAt: toIsoString(row.baseProductUpdatedAt),
    suggestedBrand: toOptionalString(row.suggestedBrand),
    suggestedModel: toOptionalString(row.suggestedModel),
    suggestedManufacturer: toOptionalString(row.suggestedManufacturer),
    suggestedCountryOfOrigin: toOptionalString(row.suggestedCountryOfOrigin),
    suggestedPeriod: toOptionalString(row.suggestedPeriod),
    suggestedMaterials: toOptionalString(row.suggestedMaterials),
    suggestedDescription: toOptionalString(row.suggestedDescription),
    suggestedProductStory: toOptionalString(row.suggestedProductStory),
    suggestedCondition: toOptionalString(row.suggestedCondition),
    suggestedConditionDescription: toOptionalString(row.suggestedConditionDescription),
    suggestedLengthValue: toOptionalNumber(row.suggestedLengthValue),
    suggestedWidthValue: toOptionalNumber(row.suggestedWidthValue),
    suggestedHeightValue: toOptionalNumber(row.suggestedHeightValue),
    suggestedDimensionUnit: toOptionalString(row.suggestedDimensionUnit),
    suggestedWeightValue: toOptionalNumber(row.suggestedWeightValue),
    suggestedWeightUnit: toOptionalString(row.suggestedWeightUnit),
    suggestedMarketingTags: row.suggestedMarketingTags ? (JSON.parse(row.suggestedMarketingTags as string) as string[]) : undefined,
    providerName: row.providerName as string,
    promptVersion: row.promptVersion as string,
    generatedAt: toIsoString(row.generatedAt),
    appliedAt: toOptionalIsoString(row.appliedAt as string | Date | null),
    appliedByAdminUserId: toOptionalString(row.appliedByAdminUserId),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function resolveCategoryName(db: DbClient, product: Product): Promise<string | undefined> {
  if (!product.categoryId) return undefined;
  try {
    return (await getCategoryById(db, product.categoryId)).name;
  } catch {
    return undefined; // Category may have been deleted/renamed since - context is best-effort only, never fatal.
  }
}

/**
 * Sprint 148: generates (or regenerates, always refreshing in place - see
 * repositories/canonical-product-proposal/types.ts's upsert doc comment) the single canonical
 * Product AI proposal for one Product. Always reads the canonical Product fresh (getProductById)
 * - never staged AI Intake data. Canonical Product photos are read via the existing
 * listReadyByProduct projection (only fully-processed, on-disk-safe photos), ordered primary-
 * first/sortOrder/id-stable and capped to readCanonicalProductAiMaxPhotos() - reused, isolated
 * image pipeline (Architecture Review item F), never marketplace-prep's text-only providers.
 */
export async function generateCanonicalProductProposal(
  db: DbClient,
  productId: string,
  provider: CanonicalProductProposalProvider = createCanonicalProductProposalProvider(),
): Promise<CanonicalProductProposal> {
  const product = await getProductById(db, productId); // throws NotFoundError if missing
  const readContext = createProductReadServiceContextForDb(db);
  const [categoryName, existingTags, rawPhotos] = await Promise.all([
    resolveCategoryName(db, product),
    listProductMarketingTags(db, productId).then((tags) => tags.map((t) => t.label)),
    readContext.repositories.photos.listReadyByProduct(productId),
  ]);

  const photos = orderAndCapCanonicalProductPhotos(rawPhotos, readCanonicalProductAiMaxPhotos());
  const context = buildCanonicalProductProposalContext(product, photos, { categoryName, existingMarketingTags: existingTags });
  const repository = createDrizzleCanonicalProductProposalRepository(db);

  const row = await generateCanonicalProductProposalUseCase(repository, provider, {
    productId,
    baseProductUpdatedAt: product.updatedAt,
    context,
    photoReader: new LocalCanonicalProductPhotoReader(),
  });
  return toCanonicalProductProposalReview(row);
}

export async function getCurrentCanonicalProductProposal(db: DbClient, productId: string): Promise<CanonicalProductProposal> {
  const repository = createDrizzleCanonicalProductProposalRepository(db);
  const row = await repository.findByProductId(productId);
  if (!row) throw new NotFoundError("Canonical product AI proposal not found");
  return toCanonicalProductProposalReview(row);
}

export interface AcceptCanonicalProductProposalServiceInput {
  expectedProposalUpdatedAt: string;
  selectedProductFields: string[];
  selectedMarketingTags: string[];
}

/**
 * Sprint 148: mirrors services/marketplacePreparation.ts's approveMarketplacePreparation exact
 * split - a fast pre-check (resolve productId -> the proposal's own id) outside any transaction,
 * then the atomic claim + selective Product write + additive Marketing Tags inside one
 * transaction (acceptCanonicalProductProposalUseCase). Returns the current canonical Product -
 * never publishes, never creates a PublishJob/PublishAttempt/ExternalListing, never changes
 * Product.status or SKU.
 */
export async function acceptCanonicalProductProposal(
  db: DbClient,
  productId: string,
  input: AcceptCanonicalProductProposalServiceInput,
  actorId: string,
): Promise<Product> {
  const repository = createDrizzleCanonicalProductProposalRepository(db);
  const existing = await repository.findByProductId(productId);
  if (!existing) throw new NotFoundError("Canonical product AI proposal not found");

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as CanonicalProductProposalApprovalTransactionDriver;
  const capability = createCanonicalProductProposalApprovalTransactionCapabilityForDb(db, driver);

  const useCaseInput: AcceptCanonicalProductProposalInput = {
    id: existing.id as string,
    productId,
    expectedProposalUpdatedAt: input.expectedProposalUpdatedAt,
    actorId,
    selectedProductFields: input.selectedProductFields,
    selectedMarketingTags: input.selectedMarketingTags,
  };
  await acceptCanonicalProductProposalUseCase(capability, useCaseInput);

  return getProductById(db, productId);
}
