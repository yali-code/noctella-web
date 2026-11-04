import type { Product } from "@noctella/shared";
import { orderAndCapCanonicalProductPhotos } from "../canonical-product-ai/context";
import { LocalCanonicalProductPhotoReader } from "../canonical-product-ai/photoReader";
import { readCanonicalProductAiMaxPhotos } from "../canonical-product-ai/providerFactory";
import type { DbClient } from "../db/client";
import type { ProductAiFillProvider } from "../product-ai-fill/contract";
import { createProductAiFillProvider } from "../product-ai-fill/providers";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import { fillProductWithAiUseCase } from "../use-cases/product-ai-fill/useCases";
import { createCanonicalProductProposalApprovalTransactionCapabilityForDb, type CanonicalProductProposalApprovalTransactionDriver } from "./canonicalProductProposalApprovalTransactionCapabilityForDb";
import { getCategoryById } from "./categories";
import { getProductById } from "./products";

const KNOWN_FIELDS = ["brand", "model", "manufacturer", "countryOfOrigin", "period", "materials", "description"] as const;

export async function fillProductWithAi(db: DbClient, productId: string, replaceExisting: boolean, provider: ProductAiFillProvider = createProductAiFillProvider()): Promise<Product> {
  const product = await getProductById(db, productId);
  const categoryName = product.categoryId ? await getCategoryById(db, product.categoryId).then((category) => category.name).catch(() => undefined) : undefined;
  const photos = await createProductReadServiceContextForDb(db).repositories.photos.listReadyByProduct(productId);
  const known: Record<string, string> = {};
  for (const key of KNOWN_FIELDS) if (product[key]) known[key] = String(product[key]);

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as CanonicalProductProposalApprovalTransactionDriver;
  await fillProductWithAiUseCase(createCanonicalProductProposalApprovalTransactionCapabilityForDb(db, driver), provider, {
    product,
    replaceExisting,
    photoReader: new LocalCanonicalProductPhotoReader(),
    context: {
      title: product.title,
      categoryName,
      condition: product.condition ?? undefined,
      conditionDescription: product.conditionDescription ?? undefined,
      purchaseCostEur: product.purchaseCost ?? undefined,
      known,
      photos: orderAndCapCanonicalProductPhotos(photos, readCanonicalProductAiMaxPhotos()),
    },
  });
  return getProductById(db, productId);
}
