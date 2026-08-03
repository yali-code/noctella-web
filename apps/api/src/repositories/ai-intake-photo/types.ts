export type AiIntakePhotoRecord = Record<string, string | number | Date | null>;

export interface AiIntakePhotoCreateInput {
  id: string;
  intakeId: string;
  storageKey: string;
  originalFilename: string;
  createdByAdminUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiIntakePhotoConflict {
  reason: "intake_not_found" | "intake_not_open";
  message: string;
}

export interface AiIntakePhotoWriteResult {
  updated: boolean;
  row?: AiIntakePhotoRecord;
  conflict?: AiIntakePhotoConflict;
}

/**
 * Sprint 91: repository for the ai_intake_photos foundation table only.
 * `create`/`listByIntake`/`findByIdAndIntake`/`deleteById` remain plain
 * single-statement operations (used directly in tests and by the locked
 * methods' own diagnostics).
 *
 * Sprint 93 correction pass: `createLockedIfIntakeOpen` and
 * `deleteByIdLockedToIntake` additionally lock the related ai_product_intakes
 * row (see services/aiIntakeLockTransactionCapabilityForDb.ts) before
 * mutating - the same intake-row lock used by
 * repositories/ai-intake-proposal/drizzle.ts's writes, so a proposal
 * generation/regeneration/review transaction and a staged-photo insert or
 * delete can never interleave for the same intake.
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
  /** Locks the intake row, re-verifies it exists and is Open, then inserts. */
  createLockedIfIntakeOpen(input: AiIntakePhotoCreateInput): Promise<AiIntakePhotoWriteResult>;
  /** Locks the intake row (regardless of its status - deletion is allowed for a cancelled intake), then deletes. */
  deleteByIdLockedToIntake(intakeId: string, id: string): Promise<void>;
}
