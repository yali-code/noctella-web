import type { Product, PublishChannel } from "@noctella/shared";
import type { MarketplacePreparationProductContext } from "./types";

/**
 * Sprint 110: a deliberately narrow, exact-match (case-insensitive, trimmed), non-substring set of
 * clearly-generic values that are never a genuine brand identity - a raw material or "no maker"
 * placeholder mistakenly stored in Product.brand (e.g. via an unreviewed AI Intake suggestion)
 * must never be handed to a Marketplace Preparation provider as if it were a trustworthy brand
 * fact (see Sprint 108's "Brand: Wood" smoke finding and the Sprint 110 Discovery/Architecture
 * Review). This is a supplemental, conservative safety net, not a claim of completeness -
 * canonical Product.brand itself is never read, modified, or reinterpreted anywhere else; human
 * review at Marketplace Preparation approval remains the final authority. Exact match only -
 * "Woodward" or "Metallica" must never be caught by this.
 */
const GENERIC_NON_BRAND_VALUES = new Set(["wood", "brass", "metal", "glass", "plastic", "ceramic", "unknown", "unbranded"]);

/**
 * Sprint 110: returns undefined for an absent/blank brand, or for a brand whose trimmed,
 * lowercased value exactly matches a known-generic non-brand term above - otherwise returns the
 * trimmed value unchanged. Only affects the ephemeral MarketplacePreparationProductContext built
 * below, never Product.brand itself.
 */
function sanitizeBrandForContext(brand: string | null | undefined): string | undefined {
  if (!brand) return undefined;
  const trimmed = brand.trim();
  if (trimmed.length === 0) return undefined;
  if (GENERIC_NON_BRAND_VALUES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Sprint 107: pure mapping from an already-fetched canonical Product into
 * MarketplacePreparationProductContext - never queries the database itself
 * (the caller, services/marketplacePreparation.ts, is responsible for
 * fetching the Product via the existing canonical getProductById). Reads
 * only canonical Product fields already reviewed/approved at Stock
 * Acceptance - never staged AI Intake data, which this module tree has no
 * import path to reach at all.
 */
export function buildMarketplacePreparationContext(product: Product, channel: PublishChannel): MarketplacePreparationProductContext {
  return {
    productId: product.id,
    channel,
    title: product.title,
    description: product.description ?? undefined,
    keywords: product.keywords && product.keywords.length > 0 ? product.keywords : undefined,
    brand: sanitizeBrandForContext(product.brand),
    model: product.model ?? undefined,
    manufacturer: product.manufacturer ?? undefined,
    countryOfOrigin: product.countryOfOrigin ?? undefined,
    period: product.period ?? undefined,
    materials: product.materials ?? undefined,
    condition: product.condition ?? undefined,
    conditionDescription: product.conditionDescription ?? undefined,
    seoTitle: product.seoTitle ?? undefined,
    metaDescription: product.metaDescription ?? undefined,
    priceEur: product.priceEur,
  };
}
