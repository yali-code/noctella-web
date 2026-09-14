import type { ProductDetail } from "./types";

export interface ProductEditSession {
  productId: string;
  immutableSku: string;
  expectedUpdatedAt: string;
}

export function beginProductEditSession(product: ProductDetail): ProductEditSession {
  return { productId: product.id, immutableSku: product.sku, expectedUpdatedAt: product.updatedAt };
}

export function advanceProductEditSession(
  session: ProductEditSession,
  updated: Pick<ProductDetail, "id" | "sku" | "updatedAt">,
): ProductEditSession {
  if (updated.id !== session.productId || updated.sku !== session.immutableSku) {
    throw new Error("Product identity changed during the edit session");
  }
  return { ...session, expectedUpdatedAt: updated.updatedAt };
}
