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
 * Sprint 95 final correction: reason "intake_not_deletable" covers Applied,
 * Finalized, and any future unrecognized status - deletion is allowlisted to
 * Open/Cancelled only (fail closed), never a blocklist of specific
 * disallowed statuses. "photo_not_found" covers both a nonexistent photo id
 * and one belonging to a different intake (findByIdAndIntake's existing
 * cross-intake-safety convention, preserved here).
 */
export interface AiIntakePhotoDeleteConflict {
  reason: "intake_not_found" | "intake_not_deletable" | "photo_not_found";
  message: string;
}

export interface AiIntakePhotoDeleteResult {
  deleted: boolean;
  conflict?: AiIntakePhotoDeleteConflict;
  /**
   * Sprint 95 final correction: the deleted row's server-owned storageKey,
   * set only on a successful deletion (deleted: true) - the caller uses this
   * to remove the staged file from disk AFTER this transaction has already
   * committed. No filesystem mutation of any kind occurs before or during
   * this transaction, so there is nothing to compensate/restore on any
   * failure inside it.
   */
  storageKey?: string;
}

/**
 * Sprint 91: repository for the ai_intake_photos foundation table only.
 * `create`/`listByIntake`/`findByIdAndIntake`/`deleteById` remain plain
 * single-statement operations (used directly in tests and by the locked
 * methods' own diagnostics).
 *
 * Sprint 93 correction pass / Sprint 95 final correction:
 * `createLockedIfIntakeOpen` and `deleteLockedToIntake` additionally lock the
 * related ai_product_intakes row (see
 * services/aiIntakeLockTransactionCapabilityForDb.ts) before mutating - the
 * same intake-row lock used by repositories/ai-intake-proposal/drizzle.ts's
 * writes, so a proposal generation/regeneration/review transaction and a
 * staged-photo insert or delete can never interleave for the same intake.
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
  /**
   * Sprint 95 final correction: the single locked delete implementation -
   * one intake-row-lock transaction that locks the intake, verifies its
   * status permits deletion, finds the owned staged-photo row (scoped by
   * both photo id and intake id), captures its storageKey, and deletes the
   * DB row - a pure database operation, with NO filesystem mutation of any
   * kind. Because nothing touches the filesystem before this transaction
   * commits, no rollback/restore compensation is ever needed: a failure at
   * any point inside this transaction (the DELETE statement itself, or the
   * commit that follows it) leaves the row and the staged file exactly as
   * they were - there is nothing to undo. The caller (services/aiIntakePhotos.ts)
   * deletes the physical file only AFTER this promise has fully resolved
   * (i.e. only after the transaction has genuinely committed).
   *
   * Replaces the prior tombstone/quarantine-before-commit design
   * (deleteWithQuarantineLockedToIntake), which performed a synchronous
   * filesystem rename inside the transaction callback - since a database
   * COMMIT can fail strictly after that callback has already returned (see
   * better-sqlite3's transaction wrapper: COMMIT runs after the callback,
   * still inside the wrapper's own try/catch, but outside the callback's),
   * any restoration logic scoped inside the callback could never observe or
   * compensate for a commit-phase failure. Performing zero filesystem work
   * before commit removes this class of bug entirely, rather than trying to
   * catch it.
   */
  deleteLockedToIntake(intakeId: string, id: string): Promise<AiIntakePhotoDeleteResult>;
}
