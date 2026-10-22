import type { StagedProductPhotoInput } from "./stagedProductPhotoStorage";
import { digestW2StagedInput } from "./w2StagedInputDigest";
import { isValidW2UploadIntent, type W2IdentityDecision, type W2UploadIntent } from "./w2OperationIdentity";

/**
 * W2 pre-publication prerequisite: bind a verified private staged file to one
 * durable immutable request identity. The caller must supply server-trusted
 * tenant/actor/product scope and a database-backed atomic claim callback.
 *
 * IMPORTANT: a NEW or SAME_INTENT result is NOT permission to publish canonical
 * files, start a second upload, or acknowledge an existing photo. The separate
 * generation-fenced owner/recovery state machine must authorize that work.
 * This function is not wired into the live route while fencing is enabled.
 */
export async function claimW2StagedInputIdentity(
  input: StagedProductPhotoInput,
  scope: { tenantId: string; actorId: string; productId: string; token: string; altText: string },
  claim: (intent: W2UploadIntent, createdMs: number) => W2IdentityDecision | Promise<W2IdentityDecision>,
  createdMs: number,
  maxBytes: number,
): Promise<W2IdentityDecision> {
  const proposed: W2UploadIntent = {
    kind: "W2_PRODUCT_PHOTO_UPLOAD",
    tenantId: scope.tenantId, actorId: scope.actorId, productId: scope.productId,
    token: scope.token, altText: scope.altText, sha256: "0".repeat(64),
  };
  if (!isValidW2UploadIntent(proposed) || !Number.isSafeInteger(createdMs) || createdMs < 0) return "INVALID";
  const sha256 = await digestW2StagedInput(input, maxBytes);
  if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED");
  return claim({ ...proposed, sha256 }, createdMs);
}
