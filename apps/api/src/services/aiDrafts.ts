import { randomUUID } from "node:crypto";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { AiDraftStatus, type AiListingDraft, ProductStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { aiListingDrafts, categories, collections, productImages, products } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import { getProductById } from "./products";
import { MockAiListingProvider } from "../ai/mockProvider";
import type { AiListingProvider } from "../ai/provider";
import type { AiDraftListQuery, RejectDraftInput, UpdateDraftInput } from "../validation/aiDraft";

/** Swappable provider — Sprint 3 wires only the local mock, no external API. */
const defaultProvider: AiListingProvider = new MockAiListingProvider();

function toDraft(row: typeof aiListingDrafts.$inferSelect): AiListingDraft {
  return {
    id: row.id,
    productId: row.productId,
    status: row.status as AiDraftStatus,
    generatedTitle: row.generatedTitle ?? undefined,
    generatedDescription: row.generatedDescription ?? undefined,
    generatedStory: row.generatedStory ?? undefined,
    generatedConditionDescription: row.generatedConditionDescription ?? undefined,
    suggestedCategoryId: row.suggestedCategoryId ?? undefined,
    suggestedCollectionId: row.suggestedCollectionId ?? undefined,
    suggestedEurPrice: row.suggestedEurPrice ?? undefined,
    suggestedUsdPrice: row.suggestedUsdPrice ?? undefined,
    suggestedMinimumOfferPrice: row.suggestedMinimumOfferPrice ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
    keywords: row.keywords ? (JSON.parse(row.keywords) as string[]) : undefined,
    shippingNote: row.shippingNote ?? undefined,
    customsWarning: row.customsWarning ?? undefined,
    aiConfidenceScore: row.aiConfidenceScore ?? undefined,
    aiModel: row.aiModel ?? undefined,
    generationPromptVersion: row.generationPromptVersion ?? undefined,
    rejectionReason: row.rejectionReason ?? undefined,
    reviewedByAdminUserId: row.reviewedByAdminUserId ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getDraftById(db: DbClient, id: string): Promise<AiListingDraft> {
  const [row] = await db.select().from(aiListingDrafts).where(eq(aiListingDrafts.id, id));
  if (!row) throw new NotFoundError("AI draft not found");
  return toDraft(row);
}

async function getDraftRow(db: DbClient, id: string) {
  const [row] = await db.select().from(aiListingDrafts).where(eq(aiListingDrafts.id, id));
  if (!row) throw new NotFoundError("AI draft not found");
  return row;
}

export interface AiDraftListItem extends AiListingDraft {
  productTitle: string;
  productSku: string;
  primaryImageUrl?: string;
}

export async function listDrafts(db: DbClient, query: AiDraftListQuery) {
  const conditions = [];
  if (query.search) {
    conditions.push(
      or(like(products.title, `%${query.search}%`), like(products.sku, `%${query.search}%`)),
    );
  }
  if (query.status) conditions.push(eq(aiListingDrafts.status, query.status));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(aiListingDrafts)
    .innerJoin(products, eq(aiListingDrafts.productId, products.id))
    .where(whereClause);

  const rows = await db
    .select({ draft: aiListingDrafts, product: products })
    .from(aiListingDrafts)
    .innerJoin(products, eq(aiListingDrafts.productId, products.id))
    .where(whereClause)
    .orderBy(desc(aiListingDrafts.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items: AiDraftListItem[] = await Promise.all(
    rows.map(async ({ draft, product }) => {
      const images = await db
        .select()
        .from(productImages)
        .where(eq(productImages.productId, product.id));
      const primary = images.find((img) => img.isPrimary) ?? images[0];
      return {
        ...toDraft(draft),
        productTitle: product.title,
        productSku: product.sku,
        primaryImageUrl: primary?.url,
      };
    }),
  );

  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Generates a new AI listing draft for a product (spec §2-3). Always
 * creates a fresh row: `Generating` while the provider runs, then either
 * `PendingReview` + generated fields on success, or `Failed` on error.
 * An older active draft (PendingReview/Approved) is marked `Superseded`
 * only after the new draft is successfully generated — a failed attempt
 * never touches the previous valid draft.
 */
export async function generateDraft(
  db: DbClient,
  productId: string,
  provider: AiListingProvider = defaultProvider,
): Promise<AiListingDraft> {
  const product = await getProductById(db, productId); // throws NotFoundError if missing

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(aiListingDrafts).values({
    id,
    productId,
    status: AiDraftStatus.Generating,
    createdAt: now,
    updatedAt: now,
  });

  let category;
  if (product.categoryId) {
    const [row] = await db.select().from(categories).where(eq(categories.id, product.categoryId));
    category = row
      ? {
          id: row.id,
          name: row.name,
          slug: row.slug,
          displayOrder: row.displayOrder,
          isActive: row.isActive,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : undefined;
  }

  let collection;
  if (product.collectionId) {
    const [row] = await db.select().from(collections).where(eq(collections.id, product.collectionId));
    collection = row
      ? {
          id: row.id,
          name: row.name,
          slug: row.slug,
          displayOrder: row.displayOrder,
          isActive: row.isActive,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : undefined;
  }

  try {
    const result = await provider.generateListing({
      product,
      images: product.images,
      category,
      collection,
    });

    const generatedAt = new Date().toISOString();
    await db
      .update(aiListingDrafts)
      .set({
        status: AiDraftStatus.PendingReview,
        generatedTitle: result.generatedTitle,
        generatedDescription: result.generatedDescription,
        generatedStory: result.generatedStory,
        generatedConditionDescription: result.generatedConditionDescription,
        suggestedCategoryId: result.suggestedCategoryId,
        suggestedCollectionId: result.suggestedCollectionId,
        suggestedEurPrice: result.suggestedEurPrice,
        suggestedUsdPrice: result.suggestedUsdPrice,
        suggestedMinimumOfferPrice: result.suggestedMinimumOfferPrice,
        seoTitle: result.seoTitle,
        metaDescription: result.metaDescription,
        keywords: result.keywords ? JSON.stringify(result.keywords) : undefined,
        shippingNote: result.shippingNote,
        customsWarning: result.customsWarning,
        aiConfidenceScore: result.aiConfidenceScore,
        aiModel: result.aiModel,
        generationPromptVersion: result.generationPromptVersion,
        updatedAt: generatedAt,
      })
      .where(eq(aiListingDrafts.id, id));

    // Supersede any previously active draft for this product, now that the
    // new one has been successfully generated.
    const previousActive = await db
      .select({ id: aiListingDrafts.id })
      .from(aiListingDrafts)
      .where(
        and(
          eq(aiListingDrafts.productId, productId),
          or(
            eq(aiListingDrafts.status, AiDraftStatus.PendingReview),
            eq(aiListingDrafts.status, AiDraftStatus.Approved),
          ),
        ),
      );
    for (const row of previousActive) {
      if (row.id === id) continue;
      await db
        .update(aiListingDrafts)
        .set({ status: AiDraftStatus.Superseded, updatedAt: generatedAt })
        .where(eq(aiListingDrafts.id, row.id));
    }

    return getDraftById(db, id);
  } catch (err) {
    // Generation failed: mark only the new row Failed. The previous valid
    // draft (if any) is left completely untouched.
    await db
      .update(aiListingDrafts)
      .set({ status: AiDraftStatus.Failed, updatedAt: new Date().toISOString() })
      .where(eq(aiListingDrafts.id, id));
    throw err;
  }
}

/** Regenerate re-runs generation for the same product as an existing draft (spec §5, §9). */
export async function regenerateDraft(
  db: DbClient,
  draftId: string,
  provider?: AiListingProvider,
): Promise<AiListingDraft> {
  const existing = await getDraftById(db, draftId);
  return generateDraft(db, existing.productId, provider);
}

export async function updateDraft(
  db: DbClient,
  id: string,
  input: UpdateDraftInput,
): Promise<AiListingDraft> {
  const existing = await getDraftRow(db, id);
  if (existing.status !== AiDraftStatus.PendingReview) {
    throw new BadRequestError(
      `Draft cannot be edited while in "${existing.status}" status; only Pending Review drafts are editable`,
    );
  }

  await db
    .update(aiListingDrafts)
    .set({
      ...(input.generatedTitle !== undefined ? { generatedTitle: input.generatedTitle } : {}),
      ...(input.generatedDescription !== undefined
        ? { generatedDescription: input.generatedDescription }
        : {}),
      ...(input.generatedStory !== undefined ? { generatedStory: input.generatedStory } : {}),
      ...(input.generatedConditionDescription !== undefined
        ? { generatedConditionDescription: input.generatedConditionDescription }
        : {}),
      ...(input.suggestedCategoryId !== undefined
        ? { suggestedCategoryId: input.suggestedCategoryId }
        : {}),
      ...(input.suggestedCollectionId !== undefined
        ? { suggestedCollectionId: input.suggestedCollectionId }
        : {}),
      ...(input.suggestedEurPrice !== undefined ? { suggestedEurPrice: input.suggestedEurPrice } : {}),
      ...(input.suggestedUsdPrice !== undefined ? { suggestedUsdPrice: input.suggestedUsdPrice } : {}),
      ...(input.suggestedMinimumOfferPrice !== undefined
        ? { suggestedMinimumOfferPrice: input.suggestedMinimumOfferPrice }
        : {}),
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.keywords !== undefined ? { keywords: JSON.stringify(input.keywords) } : {}),
      ...(input.shippingNote !== undefined ? { shippingNote: input.shippingNote } : {}),
      ...(input.customsWarning !== undefined ? { customsWarning: input.customsWarning } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(aiListingDrafts.id, id));

  return getDraftById(db, id);
}

/**
 * Approve (spec §6): copies approved draft values onto website/product
 * fields only. Never touches SKU, purchase cost, stock quantity, internal
 * notes, or ERP identity. Sets product status to Approved. Never publishes.
 */
export async function approveDraft(
  db: DbClient,
  id: string,
  reviewedByAdminUserId?: string,
): Promise<AiListingDraft> {
  const existing = await getDraftRow(db, id);
  if (existing.status !== AiDraftStatus.PendingReview) {
    throw new BadRequestError(
      `Only a Pending Review draft can be approved (current status: "${existing.status}")`,
    );
  }

  const reviewedAt = new Date().toISOString();

  await db
    .update(products)
    .set({
      ...(existing.generatedTitle !== null ? { title: existing.generatedTitle } : {}),
      ...(existing.generatedDescription !== null ? { description: existing.generatedDescription } : {}),
      ...(existing.generatedStory !== null ? { productStory: existing.generatedStory } : {}),
      ...(existing.generatedConditionDescription !== null
        ? { conditionDescription: existing.generatedConditionDescription }
        : {}),
      ...(existing.suggestedCategoryId !== null ? { categoryId: existing.suggestedCategoryId } : {}),
      ...(existing.suggestedCollectionId !== null
        ? { collectionId: existing.suggestedCollectionId }
        : {}),
      ...(existing.suggestedEurPrice !== null ? { priceEur: existing.suggestedEurPrice } : {}),
      ...(existing.suggestedUsdPrice !== null ? { priceUsd: existing.suggestedUsdPrice } : {}),
      ...(existing.suggestedMinimumOfferPrice !== null
        ? { minOfferPrice: existing.suggestedMinimumOfferPrice }
        : {}),
      ...(existing.seoTitle !== null ? { seoTitle: existing.seoTitle } : {}),
      ...(existing.metaDescription !== null ? { metaDescription: existing.metaDescription } : {}),
      ...(existing.keywords !== null ? { keywords: existing.keywords } : {}),
      ...(existing.shippingNote !== null ? { shippingNote: existing.shippingNote } : {}),
      ...(existing.customsWarning !== null ? { customsWarning: existing.customsWarning } : {}),
      status: ProductStatus.Approved,
      updatedAt: reviewedAt,
      // Explicitly NOT touched: sku, purchaseCost, stockQuantity, internalNotes, erpReferenceId.
    })
    .where(eq(products.id, existing.productId));

  await db
    .update(aiListingDrafts)
    .set({
      status: AiDraftStatus.Approved,
      reviewedByAdminUserId,
      reviewedAt,
      updatedAt: reviewedAt,
    })
    .where(eq(aiListingDrafts.id, id));

  return getDraftById(db, id);
}

/** Reject (spec §7): requires a reason, never changes the product, allows regeneration afterward. */
export async function rejectDraft(
  db: DbClient,
  id: string,
  input: RejectDraftInput,
): Promise<AiListingDraft> {
  if (!input.rejectionReason || input.rejectionReason.trim().length === 0) {
    throw new BadRequestError("Rejection reason is required");
  }

  const existing = await getDraftRow(db, id);
  if (existing.status !== AiDraftStatus.PendingReview) {
    throw new BadRequestError(
      `Only a Pending Review draft can be rejected (current status: "${existing.status}")`,
    );
  }

  const reviewedAt = new Date().toISOString();
  await db
    .update(aiListingDrafts)
    .set({
      status: AiDraftStatus.Rejected,
      rejectionReason: input.rejectionReason,
      reviewedByAdminUserId: input.reviewedByAdminUserId,
      reviewedAt,
      updatedAt: reviewedAt,
    })
    .where(eq(aiListingDrafts.id, id));

  return getDraftById(db, id);
}
