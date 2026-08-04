import type { Response } from "express";
import { ZodError } from "zod";
import { formatZodError } from "../validation/common";
import {
  AiDraftRegenerationRequiredError,
  AiDraftReviewConflictError,
  AiIntakeApplyIntakeNotOpenError,
  AiIntakeApplyPhotoSetStaleError,
  AiIntakeApplyProposalNotReadyError,
  AiIntakeApplyProposalVersionConflictError,
  AiIntakeApplyResultStateInvalidError,
  AiIntakeProposalIntakeNotOpenError,
  AiIntakeProposalReviewResetRequiredError,
  AiIntakeProposalStaleError,
  AiIntakeProposalSuggestionUnavailableError,
  AiIntakeProposalVersionConflictError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ProductVersionConflictError,
  UnauthorizedError,
} from "../services/errors";
import { InventoryUseCaseError, type InventoryErrorCategory } from "../application/inventory/errors";

// Sprint 64D: InventoryUseCaseError previously fell through to the generic 500 branch below -
// it doesn't extend BadRequestError/ConflictError/NotFoundError, so none of the checks above
// recognized it. Mapped here by category (set per-subclass in application/inventory/errors.ts)
// rather than by instanceof-per-subclass, so new inventory error subtypes are covered
// automatically as long as they declare a category.
const INVENTORY_ERROR_STATUS: Record<InventoryErrorCategory, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
};

export function handleRouteError(err: unknown, res: Response): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: formatZodError(err) });
    return;
  }
  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  // Sprint 88: checked before the generic ConflictError branch below, since
  // ProductVersionConflictError extends ConflictError - order matters here.
  if (err instanceof ProductVersionConflictError) {
    res.status(409).json({
      error: err.message,
      code: "PRODUCT_VERSION_CONFLICT",
      productId: err.productId,
      expectedUpdatedAt: err.expectedUpdatedAt,
      currentUpdatedAt: err.currentUpdatedAt,
    });
    return;
  }
  // Sprint 89: checked before the generic ConflictError branch below, for the same
  // subclass-ordering reason as ProductVersionConflictError above.
  if (err instanceof AiDraftRegenerationRequiredError) {
    res.status(409).json({ error: err.message, code: "AI_DRAFT_REGENERATION_REQUIRED" });
    return;
  }
  if (err instanceof AiDraftReviewConflictError) {
    res.status(409).json({ error: err.message, code: "AI_DRAFT_REVIEW_CONFLICT" });
    return;
  }
  // Sprint 93: checked before the generic ConflictError branch below, for the same
  // subclass-ordering reason as the Sprint 88/89 conflict subclasses above.
  if (err instanceof AiIntakeProposalReviewResetRequiredError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_PROPOSAL_REVIEW_RESET_REQUIRED" });
    return;
  }
  if (err instanceof AiIntakeProposalStaleError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_PROPOSAL_STALE" });
    return;
  }
  if (err instanceof AiIntakeProposalIntakeNotOpenError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_PROPOSAL_INTAKE_NOT_OPEN" });
    return;
  }
  if (err instanceof AiIntakeProposalVersionConflictError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_PROPOSAL_VERSION_CONFLICT" });
    return;
  }
  // Sprint 94: checked before the generic ConflictError branch below, for the same
  // subclass-ordering reason as the Sprint 88/89/93 conflict subclasses above.
  if (err instanceof AiIntakeApplyIntakeNotOpenError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_APPLY_INTAKE_NOT_OPEN" });
    return;
  }
  if (err instanceof AiIntakeApplyProposalVersionConflictError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_APPLY_PROPOSAL_VERSION_CONFLICT" });
    return;
  }
  if (err instanceof AiIntakeApplyProposalNotReadyError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_APPLY_PROPOSAL_NOT_READY" });
    return;
  }
  if (err instanceof AiIntakeApplyPhotoSetStaleError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_APPLY_PHOTO_SET_STALE" });
    return;
  }
  if (err instanceof AiIntakeApplyResultStateInvalidError) {
    res.status(409).json({ error: err.message, code: "AI_INTAKE_APPLY_RESULT_STATE_INVALID" });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  // Sprint 93 correction pass: checked before the generic BadRequestError branch below, for the
  // same subclass-ordering reason as the ConflictError subclasses above.
  if (err instanceof AiIntakeProposalSuggestionUnavailableError) {
    res.status(400).json({ error: err.message, code: "AI_INTAKE_PROPOSAL_SUGGESTION_UNAVAILABLE" });
    return;
  }
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof InventoryUseCaseError) {
    res.status(INVENTORY_ERROR_STATUS[err.category]).json({ error: err.message });
    return;
  }
  // Sprint 69: an unmapped exception's raw message, a JSON.stringify of it, or even a redacted
  // derivative could still echo user-controlled/upstream text (a token, connection string, etc).
  // Logging a fixed operational message is the only way to guarantee that never happens - err is
  // deliberately never touched here, not even indirectly.
  // eslint-disable-next-line no-console
  console.error("Unhandled route error");
  res.status(500).json({ error: "Internal server error" });
}
