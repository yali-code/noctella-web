import { AiIntakePhotoMutationNotAllowedError, BadRequestError, NotFoundError } from "../../services/errors";
import type { AiIntakePhotoDeleteResult, AiIntakePhotoRepository } from "../../repositories/ai-intake-photo/types";

export interface CreateAiIntakePhotoInput {
  id: string;
  intakeId: string;
  storageKey: string;
  originalFilename: string;
  createdByAdminUserId: string;
}

export async function createAiIntakePhotoUseCase(repository: AiIntakePhotoRepository, input: CreateAiIntakePhotoInput) {
  const now = new Date().toISOString();
  return repository.create({ ...input, createdAt: now, updatedAt: now });
}

/**
 * Sprint 93 correction pass: locks the intake row and re-verifies it exists
 * and is Open from a fresh read taken inside that lock, before inserting -
 * the same intake-row lock repositories/ai-intake-proposal writes take, so a
 * proposal generation/regeneration/review transaction and this insert can
 * never interleave for the same intake. A service-layer pre-check alone (the
 * existing getIntakeById/status check in services/aiIntakePhotos.ts) is not
 * sufficient on its own.
 */
export async function createAiIntakePhotoLockedUseCase(repository: AiIntakePhotoRepository, input: CreateAiIntakePhotoInput) {
  const now = new Date().toISOString();
  const result = await repository.createLockedIfIntakeOpen({ ...input, createdAt: now, updatedAt: now });
  if (!result.updated) {
    if (result.conflict?.reason === "intake_not_found") throw new NotFoundError(result.conflict.message);
    throw new BadRequestError(result.conflict?.message ?? "AI product intake is not Open");
  }
  return result.row!;
}

export async function listAiIntakePhotosUseCase(repository: AiIntakePhotoRepository, intakeId: string) {
  return repository.listByIntake(intakeId);
}

/**
 * Sprint 91: scoped lookup - a photo id that exists but belongs to a
 * different intake is treated identically to a nonexistent photo (both
 * NotFoundError), so cross-intake access is structurally impossible rather
 * than merely permission-checked.
 */
export async function findAiIntakePhotoUseCase(repository: AiIntakePhotoRepository, intakeId: string, photoId: string) {
  const existing = await repository.findByIdAndIntake(intakeId, photoId);
  if (!existing) throw new NotFoundError("AI intake photo not found");
  return existing;
}

/** Deletes only the database record - the caller is responsible for deleting the staged file first. */
export async function deleteAiIntakePhotoUseCase(repository: AiIntakePhotoRepository, photoId: string) {
  await repository.deleteById(photoId);
}

/**
 * Sprint 95 final correction: the single locked delete use case - status
 * check, ownership check, and the database row delete all happen inside
 * repository.deleteLockedToIntake's one intake-row-lock transaction, with no
 * filesystem operation of any kind inside it. Returns the result (including
 * the deleted row's storageKey) rather than void, so the caller
 * (services/aiIntakePhotos.ts) can delete the physical staged file only
 * after this promise has fully resolved - i.e. only after the transaction
 * has genuinely committed.
 */
export async function deleteAiIntakePhotoLockedUseCase(
  repository: AiIntakePhotoRepository,
  intakeId: string,
  photoId: string,
): Promise<AiIntakePhotoDeleteResult> {
  const result = await repository.deleteLockedToIntake(intakeId, photoId);
  if (!result.deleted) {
    if (result.conflict?.reason === "intake_not_found" || result.conflict?.reason === "photo_not_found") {
      throw new NotFoundError(result.conflict.message);
    }
    throw new AiIntakePhotoMutationNotAllowedError(result.conflict?.message);
  }
  return result;
}
