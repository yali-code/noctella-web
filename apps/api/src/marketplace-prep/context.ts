import type { Product, PublishChannel } from "@noctella/shared";
import type { MarketplacePreparationProductContext } from "./types";

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
    brand: product.brand ?? undefined,
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
