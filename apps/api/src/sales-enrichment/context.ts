import type { Product } from "@noctella/shared";
import type { SalesEnrichmentProductContext } from "./types";

/**
 * Sprint 140: pure mapping from an already-fetched canonical Product into
 * SalesEnrichmentProductContext - never queries the database itself (the caller is responsible
 * for fetching the Product via the existing canonical getProductById). Reads only canonical
 * Product fields already reviewed/approved at Stock Acceptance - never staged AI Intake data.
 */
export function buildSalesEnrichmentContext(product: Product): SalesEnrichmentProductContext {
  return {
    productId: product.id,
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
  };
}
