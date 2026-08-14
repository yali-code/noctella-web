import type { Product } from "@noctella/shared";
import type { CanonicalProductPhotoReference, CanonicalProductProposalContext } from "./types";

/** A minimal, storage-agnostic photo shape - satisfied by ProductPhotoReadProjection without importing the repository layer here. */
export interface CanonicalProductPhotoOrderingInput {
  id: string;
  url: string;
  isPrimary: boolean;
  sortOrder: number;
}

/**
 * Sprint 148: primary-first, then sortOrder, then a stable id tie-break, then capped to
 * maxPhotos - Architecture Review item F's exact required ordering. `Array.prototype.sort` is
 * stable (guaranteed since ES2019), so pre-sorting by (sortOrder, id) ascending and then
 * stable-sorting isPrimary to the front preserves that ordering among non-primary photos exactly.
 */
export function orderAndCapCanonicalProductPhotos(photos: CanonicalProductPhotoOrderingInput[], maxPhotos: number): CanonicalProductPhotoReference[] {
  const bySortOrderThenId = [...photos].sort((a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id));
  const primaryFirst = [...bySortOrderThenId].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return primaryFirst.slice(0, Math.max(0, maxPhotos)).map((p) => ({ id: p.id, url: p.url }));
}

/**
 * Sprint 148: pure mapping from an already-fetched canonical Product (+ category name + existing
 * Marketing Tags + ordered/capped photos, all supplied by the caller) into
 * CanonicalProductProposalContext - never queries the database itself, mirroring
 * marketplace-prep/context.ts's own established convention exactly.
 */
export function buildCanonicalProductProposalContext(
  product: Product,
  photos: CanonicalProductPhotoReference[],
  options: { categoryName?: string; existingMarketingTags?: string[] } = {},
): CanonicalProductProposalContext {
  return {
    productId: product.id,
    title: product.title,
    categoryName: options.categoryName,
    brand: product.brand ?? undefined,
    model: product.model ?? undefined,
    manufacturer: product.manufacturer ?? undefined,
    countryOfOrigin: product.countryOfOrigin ?? undefined,
    period: product.period ?? undefined,
    materials: product.materials ?? undefined,
    description: product.description ?? undefined,
    productStory: product.productStory ?? undefined,
    condition: product.condition ?? undefined,
    conditionDescription: product.conditionDescription ?? undefined,
    lengthValue: product.lengthValue ?? undefined,
    widthValue: product.widthValue ?? undefined,
    heightValue: product.heightValue ?? undefined,
    dimensionUnit: product.dimensionUnit ?? undefined,
    weightValue: product.weightValue ?? undefined,
    weightUnit: product.weightUnit ?? undefined,
    existingMarketingTags: options.existingMarketingTags && options.existingMarketingTags.length > 0 ? options.existingMarketingTags : undefined,
    photos,
  };
}
