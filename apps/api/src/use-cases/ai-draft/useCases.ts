import { AiDraftStatus } from "@noctella/shared";
import { AiDraftRegenerationRequiredError, AiDraftReviewConflictError, BadRequestError, NotFoundError } from "../../services/errors";
import { updateProductWithInventoryInTransactionUseCase } from "../product-write/useCases";
import type { AiDraftApprovalTransactionCapability } from "../../services/aiDraftApprovalTransactionCapabilityForDb";
import type { InventoryApplicationContext } from "../../services/inventoryApplicationContext";

const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>) =>
  value instanceof Promise ? value.then(next) : next(value);

export interface ApproveAiListingDraftInput {
  id: string;
  status: string;
  productId: string;
  baseProductUpdatedAt: string | null;
  reviewedByAdminUserId: string;
  /** Canonical Product field values already mapped from the draft, plus status: Approved. */
  productValues: Record<string, string | number | boolean | null>;
}

/**
 * Sprint 89 (Option B): opens exactly one transaction containing both the
 * atomic AI Draft PendingReview claim and the canonical transaction-scoped
 * Product update. Either operation failing rolls back both - the claim is
 * attempted first (cheap, purely-local; a lost concurrent-approval race
 * fails before ever touching the Product), then the Product update runs
 * using the draft's durable baseProductUpdatedAt as expectedUpdatedAt.
 *
 * Pre-transaction validation (PendingReview status, non-null baseline,
 * category/collection existence) is the caller's responsibility
 * (services/aiDrafts.ts's approveDraft), exactly mirroring how
 * services/products.ts's updateProduct validates before calling
 * updateProductWithInventoryUseCase.
 */
export function approveAiListingDraftUseCase(
  capability: AiDraftApprovalTransactionCapability,
  inventoryCtx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  input: ApproveAiListingDraftInput,
) {
  if (input.status !== AiDraftStatus.PendingReview) {
    throw new BadRequestError(`Only a Pending Review draft can be approved (current status: "${input.status}")`);
  }
  if (!input.baseProductUpdatedAt) {
    throw new AiDraftRegenerationRequiredError();
  }

  const reviewedAt = new Date().toISOString();
  const baseProductUpdatedAt = input.baseProductUpdatedAt;

  return capability.run(({ aiDraftApprovalRepository, productWriteRepositories, inventoryRepositories }) =>
    chain(
      aiDraftApprovalRepository.claimAndApprove({
        id: input.id,
        reviewedByAdminUserId: input.reviewedByAdminUserId,
        reviewedAt,
        updatedAt: reviewedAt,
      }),
      (claim) => {
        if (!claim.updated) {
          if (claim.conflict?.field === "id") throw new NotFoundError(claim.conflict.message);
          throw new AiDraftReviewConflictError();
        }
        // Sprint 89 correction: expectedUpdatedAt and currentUpdatedAtForNextVersion are both
        // baseProductUpdatedAt - valid because approval may only proceed while the Product still
        // matches that generation baseline (enforced by the WHERE predicate itself). The
        // transaction-scoped function computes and injects the actual new Product version; this
        // caller never puts `updatedAt` in productValues.
        return updateProductWithInventoryInTransactionUseCase(
          { productWriteRepositories, inventoryRepositories } as any,
          inventoryCtx,
          {
            id: input.productId,
            values: input.productValues,
            expectedUpdatedAt: baseProductUpdatedAt,
            currentUpdatedAtForNextVersion: baseProductUpdatedAt,
            // AI Draft approval never changes stock/Inventory - stockQuantity
            // stays undefined so updateProductWithInventoryInTransactionUseCase's
            // own undefined-check short-circuits before touching Inventory.
          },
        );
      },
    ),
  );
}
