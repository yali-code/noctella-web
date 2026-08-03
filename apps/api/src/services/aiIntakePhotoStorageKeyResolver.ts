import type { DbClient } from "../db/client";
import { createAiIntakePhotoRepository } from "../repositories/ai-intake-photo/factory";
import type { AiIntakePhotoStorageKeyResolver } from "../ai-intake/types";

/**
 * Sprint 92 exact-review correction: resolves an opaque intake-scoped photo
 * id to its Sprint 91 storage key using the existing canonical
 * AiIntakePhotoRepository.findByIdAndIntake - no raw SQL, no new repository
 * method. Intake-scoped by construction: a photo id belonging to a
 * different intake resolves to null (findByIdAndIntake already guarantees
 * this - see repositories/ai-intake-photo/types.ts), so cross-intake photo
 * resolution is not possible through this resolver.
 */
export function createIntakeScopedPhotoStorageKeyResolver(db: DbClient, intakeId: string): AiIntakePhotoStorageKeyResolver {
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  const repository = createAiIntakePhotoRepository(driver, db);
  return {
    async resolve(photoId: string): Promise<string | null> {
      const record = await repository.findByIdAndIntake(intakeId, photoId);
      return (record?.storageKey as string | undefined) ?? null;
    },
  };
}
