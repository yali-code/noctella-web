import { createHash } from "node:crypto";
import type { AiIntakePhoto } from "@noctella/shared";

/**
 * Sprint 93: deterministic fingerprint of an intake's current staged-photo
 * set, built from the canonical ordered photo IDs already returned by
 * listIntakePhotos (created_at ASC, id ASC) - never from binary content.
 * ai_intake_photos rows are never updated in place (only created/deleted),
 * so an added, deleted, or replaced photo always changes either the id list
 * itself or its order, and the empty set produces a stable, well-defined
 * fingerprint (`JSON.stringify([])` = "[]").
 */
export function computePhotoSetFingerprint(photos: Pick<AiIntakePhoto, "id">[]): string {
  const orderedIds = photos.map((photo) => photo.id);
  return createHash("sha256").update(JSON.stringify(orderedIds)).digest("hex");
}
