import type { ProductType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getIntakeById } from "./aiProductIntakes";
import { getProductById } from "./products";
import { AiIntakeApplyResultStateInvalidError, NotFoundError } from "./errors";
import { createAiIntakeApplyTransactionCapabilityForDb, type AiIntakeApplyTransactionDriver } from "./aiIntakeApplyTransactionCapabilityForDb";
import { stockAcceptanceUseCase } from "../use-cases/ai-intake-stock-acceptance/useCases";
import type { StockAcceptanceInput as StockAcceptanceRequestInput } from "../validation/aiIntakeStockAcceptance";

export interface StockAcceptanceServiceResult {
  /** false for the idempotent already-Applied retry - no new canonical write was performed, no SKU allocated. */
  created: boolean;
  product: Awaited<ReturnType<typeof getProductById>>;
}

/**
 * Sprint 106: mirrors services/aiIntakeApply.ts's saveAiIntakeAsDraft exactly
 * - same fast pre-check / authoritative-transaction split, same
 * canonical-Product-read-after-commit pattern, same idempotent-Applied error
 * translation. Reuses the SAME AiIntakeApplyTransactionCapability
 * (createAiIntakeApplyTransactionCapabilityForDb) - not a new capability -
 * only the use-case invoked differs (stockAcceptanceUseCase instead of
 * applyAiIntakeUseCase), per the approved Option B architecture.
 */
export async function acceptAiIntakeIntoStock(
  db: DbClient,
  intakeId: string,
  input: StockAcceptanceRequestInput,
  actorId: string,
): Promise<StockAcceptanceServiceResult> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as AiIntakeApplyTransactionDriver;
  const capability = createAiIntakeApplyTransactionCapabilityForDb(db, driver);

  const result = await stockAcceptanceUseCase(capability, {
    intakeId,
    categoryId: input.categoryId,
    type: input.type as ProductType,
    priceEur: input.priceEur,
    stockQuantity: input.stockQuantity,
    brand: input.brand,
    model: input.model,
    manufacturer: input.manufacturer,
    countryOfOrigin: input.countryOfOrigin,
    period: input.period,
    materials: input.materials,
    condition: input.condition,
    conditionDescription: input.conditionDescription,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    expectedProposalUpdatedAt: input.expectedProposalUpdatedAt,
    actorId,
  });

  try {
    const product = await getProductById(db, result.productId);
    return { created: result.created, product };
  } catch (err) {
    // Mirrors saveAiIntakeAsDraft's identical Sprint 94 correction exactly - narrowly translated
    // only for the idempotent already-Applied path.
    if (!result.created && err instanceof NotFoundError) {
      throw new AiIntakeApplyResultStateInvalidError("This intake's result Product could not be found.");
    }
    throw err;
  }
}
