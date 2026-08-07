import type { AiIntakePhoto, AiProductIntake } from "@noctella/shared";
import type { AiIntakeAllowedCategory, AiIntakeGenerationContext } from "./types";

/**
 * Sprint 92 (exact-review correction): pure mapping from already-fetched
 * Sprint 90/91 domain records into AiIntakeGenerationContext. Never queries
 * the database itself - the caller (services/aiIntakeGeneration.ts) is
 * responsible for fetching `intake`/`photos` via the existing canonical
 * getIntakeById/listIntakePhotos services.
 *
 * `referenceId` is the canonical photo id (`photo.id`), NOT `photo.storageKey`
 * - a true opaque identifier, not a rename of the storage key. The context
 * built here contains no storage key value anywhere. Resolving a referenceId
 * back to a storage key happens only behind AiIntakePhotoReader, via
 * services/aiIntakePhotoStorageKeyResolver.ts.
 *
 * Sprint 106: `allowedCategories` is fetched by the caller from the existing
 * canonical category list (services/categories.ts's listCategories) and
 * passed through unchanged - this function never queries categories itself,
 * matching its own established "pure mapping, no DB access" contract.
 * Defaults to an empty array so every pre-Sprint-106 call site remains valid.
 */
export function buildAiIntakeGenerationContext(
  intake: AiProductIntake,
  photos: AiIntakePhoto[],
  allowedCategories: AiIntakeAllowedCategory[] = [],
): AiIntakeGenerationContext {
  return {
    intakeId: intake.id,
    photos: photos.map((photo) => ({
      id: photo.id,
      originalFilename: photo.originalFilename,
      referenceId: photo.id,
    })),
    allowedCategories,
  };
}
