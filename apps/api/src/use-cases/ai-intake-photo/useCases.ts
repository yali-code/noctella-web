import { NotFoundError } from "../../services/errors";
import type { AiIntakePhotoRepository } from "../../repositories/ai-intake-photo/types";

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

export async function listAiIntakePhotosUseCase(repository: AiIntakePhotoRepository, intakeId: string) {
  return repository.listByIntake(intakeId);
}

/**
 * Sprint 91: scoped lookup - a photo id that exists but belongs to a
 * different intake is treated identically to a nonexistent photo (both
 * NotFoundError), so cross-intake access is structurally impossible rather
 * than merely permission-checked. Deletion is split into find/delete steps
 * (rather than one combined operation) so the caller can delete the staged
 * file between them - see services/aiIntakePhotos.ts's deleteIntakePhoto for
 * the required file-before-database-record ordering.
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
