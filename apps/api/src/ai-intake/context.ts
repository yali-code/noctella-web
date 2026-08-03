import type { AiIntakePhoto, AiProductIntake } from "@noctella/shared";
import type { AiIntakeGenerationContext } from "./types";

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
 */
export function buildAiIntakeGenerationContext(intake: AiProductIntake, photos: AiIntakePhoto[]): AiIntakeGenerationContext {
  return {
    intakeId: intake.id,
    photos: photos.map((photo) => ({
      id: photo.id,
      originalFilename: photo.originalFilename,
      referenceId: photo.id,
    })),
  };
}
