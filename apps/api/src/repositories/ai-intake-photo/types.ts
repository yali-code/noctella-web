export type AiIntakePhotoRecord = Record<string, string | number | null>;

export interface AiIntakePhotoCreateInput {
  id: string;
  intakeId: string;
  storageKey: string;
  originalFilename: string;
  createdByAdminUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 91: repository for the ai_intake_photos foundation table only.
 * Every operation here is single-statement, so no transaction capability is
 * needed - each method runs directly against the passed-in db handle,
 * matching repositories/ai-product-intake/types.ts's precedent.
 */
export interface AiIntakePhotoRepository {
  create(input: AiIntakePhotoCreateInput): Promise<AiIntakePhotoRecord>;
  /** Ordered by created_at ASC, then id ASC. */
  listByIntake(intakeId: string): Promise<AiIntakePhotoRecord[]>;
  /**
   * Scoped lookup - returns null both when the photo doesn't exist and when
   * it belongs to a different intake, so callers can't distinguish "wrong
   * intake" from "doesn't exist" (cross-intake deletion must not be possible).
   */
  findByIdAndIntake(intakeId: string, id: string): Promise<AiIntakePhotoRecord | null>;
  deleteById(id: string): Promise<void>;
}
