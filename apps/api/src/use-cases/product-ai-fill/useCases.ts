import { randomUUID } from "node:crypto";
import type { Product } from "@noctella/shared";
import type { CanonicalProductPhotoReader } from "../../canonical-product-ai/types";
import { PRODUCT_AI_FILL_TEXT_FIELDS, type ProductAiFillContext, type ProductAiFillProvider, type ProductAiFillResult } from "../../product-ai-fill/contract";
import { CanonicalProductProposalGenerationInProgressError } from "../../services/errors";
import { canonicalizeMarketingTagKey } from "../../services/marketingTags";
import type { CanonicalProductProposalApprovalTransactionCapability } from "../../services/canonicalProductProposalApprovalTransactionCapabilityForDb";
import { releaseCanonicalProductProposalGenerationGuard, tryAcquireCanonicalProductProposalGenerationGuard } from "../canonical-product-proposal/generationGuard";
import { updateProductWithInventoryInTransactionUseCase } from "../product-write/useCases";

const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));
const isBlank = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const MAX_LENGTHS: Partial<Record<keyof ProductAiFillResult, number>> = { ebayTitle: 80, etsyTitle: 140 };
/** The warehouse note stays authoritative; a replace run never overwrites it or an admin price. */
const NEVER_REPLACED = new Set<string>(["conditionDescription", "priceEur", "priceUsd", "minOfferPrice"]);

/** Maps the AI result onto Product columns. Blank fields are always filled; existing text changes only when replaceExisting is set. */
export function mapProductAiFillToProductValues(product: Product, result: ProductAiFillResult, replaceExisting: boolean): Record<string, string | number> {
  const current = product as unknown as Record<string, unknown>;
  const values: Record<string, string | number> = {};
  const allowed = (key: string) => isBlank(current[key]) || (replaceExisting && !NEVER_REPLACED.has(key));

  for (const key of PRODUCT_AI_FILL_TEXT_FIELDS) {
    const text = result[key].trim();
    if (text && allowed(key)) values[key] = text.slice(0, MAX_LENGTHS[key] ?? text.length);
  }
  const clean = (list: string[]) => [...new Set(list.map((item) => item.trim()).filter(Boolean))];
  if (allowed("keywords") && clean(result.keywords).length) values.keywords = JSON.stringify(clean(result.keywords));
  const tags = clean(result.etsyTags).filter((tag) => tag.length <= 20).slice(0, 13);
  if (allowed("etsyTags") && tags.length) values.etsyTags = JSON.stringify(tags);

  if (allowed("priceEur") && result.priceEur > 0) values.priceEur = result.priceEur;
  if (allowed("priceUsd") && result.priceUsd > 0) values.priceUsd = result.priceUsd;
  const ceiling = (values.priceEur as number | undefined) ?? product.priceEur;
  if (allowed("minOfferPrice") && result.minOfferPrice > 0 && (ceiling == null || result.minOfferPrice <= ceiling)) values.minOfferPrice = result.minOfferPrice;
  return values;
}

export interface FillProductWithAiInput {
  product: Product;
  context: ProductAiFillContext;
  photoReader: CanonicalProductPhotoReader;
  replaceExisting: boolean;
}

/** The single paid call runs outside any transaction; persistence is atomic and version-checked, and never touches stock, status or publishing. */
export async function fillProductWithAiUseCase(capability: CanonicalProductProposalApprovalTransactionCapability, provider: ProductAiFillProvider, input: FillProductWithAiInput): Promise<void> {
  const { product } = input;
  if (!tryAcquireCanonicalProductProposalGenerationGuard(product.id)) throw new CanonicalProductProposalGenerationInProgressError();
  try {
    const result = await provider.fill({ context: input.context, photoReader: input.photoReader });
    const values = mapProductAiFillToProductValues(product, result, input.replaceExisting);
    const labels = result.marketingTags.map((label) => ({ label: label.trim(), key: canonicalizeMarketingTagKey(label) })).filter((tag) => tag.key);
    await capability.run((ctx) =>
      chain(
        updateProductWithInventoryInTransactionUseCase(
          { productWriteRepositories: ctx.productWriteRepositories, inventoryRepositories: ctx.inventoryRepositories } as any,
          { clock: { now: () => new Date() }, idGenerator: { newId: () => randomUUID() } },
          { id: product.id, values, expectedUpdatedAt: product.updatedAt, currentUpdatedAtForNextVersion: product.updatedAt },
        ),
        () => labels.reduce<unknown>(
          (previous, tag) => chain(previous, () => chain(ctx.marketingTagWriteRepository.findOrCreateByKey(tag.key!, tag.label), (row: any) => ctx.marketingTagWriteRepository.addRelation(product.id, row.id))),
          undefined,
        ),
      ),
    );
  } finally {
    releaseCanonicalProductProposalGenerationGuard(product.id);
  }
}
