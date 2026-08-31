import { ProductStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import type { ProductReadServiceContext } from "../repositories/product-read/types";
import type { PublicCartReconciliationInput } from "../validation/cartReconciliation";

export type PublicCartReconciliationItem =
  | { productId: string; availability: "unavailable"; reason: "unavailable" | "out_of_stock" }
  | {
      productId: string;
      availability: "available";
      slug: string;
      title: string;
      primaryImageUrl?: string;
      priceEur: number;
      priceUsd?: number;
      productType: string;
      allowCashOnDelivery: boolean;
    };

/**
 * Public cart reconciliation is deliberately narrower than the full Product projection. Missing,
 * hidden, paused, unpublished, and sold rows collapse into the same customer-safe state. Exact
 * inventory, internal lifecycle state, SKU, cost, marketplace data, and staff fields never leave
 * this boundary.
 */
export async function reconcilePublicCart(
  db: DbClient,
  input: PublicCartReconciliationInput,
  context: ProductReadServiceContext = createProductReadServiceContextForDb(db),
): Promise<{ items: PublicCartReconciliationItem[] }> {
  const seen = new Set<string>();
  const productIds = input.items.map((item) => item.productId).filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const items = await Promise.all(productIds.map(async (productId): Promise<PublicCartReconciliationItem> => {
    const product = await context.repositories.products.getById(productId);
    if (!product || product.status !== ProductStatus.Published || product.salePausedAt) {
      return { productId, availability: "unavailable", reason: "unavailable" };
    }
    if (product.stockQuantity < 1) {
      return { productId, availability: "unavailable", reason: "out_of_stock" };
    }

    const photos = await context.repositories.photos.listPubliclyVisibleByProduct(productId);
    const primary = photos.find((photo) => Boolean(photo.isPrimary)) ?? photos[0];
    return {
      productId,
      availability: "available",
      slug: product.slug,
      title: product.wooProductName ?? product.title,
      primaryImageUrl: primary?.url,
      priceEur: (product.wooListingPriceEur ?? product.priceEur)!,
      priceUsd: product.priceUsd ?? undefined,
      productType: product.type,
      allowCashOnDelivery: product.allowCashOnDelivery,
    };
  }));

  return { items };
}
