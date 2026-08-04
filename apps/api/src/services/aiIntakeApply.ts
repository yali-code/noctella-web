import type { ProductType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getIntakeById } from "./aiProductIntakes";
import { getProductById } from "./products";
import { AiIntakeApplyResultStateInvalidError, NotFoundError } from "./errors";
import { createAiIntakeApplyTransactionCapabilityForDb, type AiIntakeApplyTransactionDriver } from "./aiIntakeApplyTransactionCapabilityForDb";
import { applyAiIntakeUseCase } from "../use-cases/ai-intake-apply/useCases";
import type { SaveAiIntakeAsDraftInput } from "../validation/aiIntakeApply";

export interface SaveAiIntakeAsDraftResult {
  /** false for the idempotent already-Applied retry - no new canonical write was performed. */
  created: boolean;
  product: Awaited<ReturnType<typeof getProductById>>;
}

/**
 * Sprint 94: fast pre-check only (404 for a clearly-nonexistent intake,
 * before opening a transaction) - the authoritative status/version/readiness
 * validation happens entirely inside applyAiIntakeUseCase's locked
 * transaction, exactly mirroring services/aiIntakeProposals.ts's established
 * pre-check-vs-authoritative-transaction split. The canonical Product is
 * read after commit via the same getProductById every other Product route
 * uses - never an intake-specific partial representation.
 */
export async function saveAiIntakeAsDraft(
  db: DbClient,
  intakeId: string,
  input: SaveAiIntakeAsDraftInput,
  actorId: string,
): Promise<SaveAiIntakeAsDraftResult> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as AiIntakeApplyTransactionDriver;
  const capability = createAiIntakeApplyTransactionCapabilityForDb(db, driver);

  const result = await applyAiIntakeUseCase(capability, {
    intakeId,
    sku: input.sku,
    categoryId: input.categoryId,
    type: input.type as ProductType,
    priceEur: input.priceEur,
    stockQuantity: input.stockQuantity,
    expectedProposalUpdatedAt: input.expectedProposalUpdatedAt,
    actorId,
  });

  try {
    const product = await getProductById(db, result.productId);
    return { created: result.created, product };
  } catch (err) {
    // Sprint 94 correction: narrowly translated only for the idempotent
    // already-Applied path - a resultProductId that exists but no longer
    // resolves to a Product is a deterministic conflict, not "not found",
    // and must never be repaired by creating a second Product. The
    // first-application path's Product read (result.created === true)
    // should never realistically 404 (the Product was just created in the
    // same transaction that set resultProductId), so it is deliberately not
    // translated here - only Applied/missing-Product is.
    if (!result.created && err instanceof NotFoundError) {
      throw new AiIntakeApplyResultStateInvalidError("This intake's result Product could not be found.");
    }
    throw err;
  }
}
