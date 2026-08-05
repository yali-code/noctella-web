/**
 * Sprint 96: a narrow, cleanup-only repository - separate from
 * repositories/ai-intake-photo (public staged-photo CRUD) and
 * repositories/ai-product-intake (public intake lifecycle). Every method
 * here exists only to support the internal retention-cleanup use case
 * (use-cases/ai-intake-cleanup/useCases.ts) - none of these methods are
 * reachable from the public staged-photo DELETE endpoint or any other
 * existing route.
 */

export interface AiIntakeCleanupCandidateIntake {
  id: string;
  status: string;
  cancelledAt: string | null;
  finalizedAt: string | null;
}

/**
 * A strict, closed union - never an arbitrary column name or status string.
 * The repository implementation internally maps each variant to exactly one
 * expected status and exactly one audit-timestamp column; no caller can
 * supply either directly.
 */
export type AiIntakeRetentionCleanupRequest =
  | { kind: "cancelled"; cutoff: string }
  | { kind: "finalized"; cutoff: string };

export interface AiIntakeRetentionCleanupDeletedPhoto {
  id: string;
  storageKey: string;
}

export type AiIntakeRetentionCleanupResult =
  | { cleaned: true; deletedPhotos: AiIntakeRetentionCleanupDeletedPhoto[] }
  | { cleaned: false; reason: "not_found" | "status_changed" | "missing_audit_timestamp" | "not_yet_eligible" };

export interface AiIntakeCleanupRepository {
  /**
   * Distinct/EXISTS-equivalent: only ever returns a Cancelled intake with
   * cancelledAt <= cancelledCutoff, or a Finalized intake with
   * finalizedAt <= finalizedCutoff, that currently owns at least one
   * ai_intake_photos row (an already-fully-cleaned terminal intake is never
   * returned again). Ordered by retention origin ascending, then id
   * ascending, for deterministic batch behavior across runs.
   */
  listTerminalIntakesWithStagedPhotosEligibleForRetention(input: {
    cancelledCutoff: string;
    finalizedCutoff: string;
    limit: number;
  }): Promise<AiIntakeCleanupCandidateIntake[]>;

  /**
   * One bounded, intake-locked transaction: locks the intake, verifies its
   * status still matches `request.kind` exactly, verifies the matching audit
   * timestamp is present and still <= `request.cutoff`, selects owned staged
   * rows (createdAt ASC, id ASC, limited to `remainingBudget`), deletes
   * exactly those rows (DELETE ... RETURNING, with an affected-row/id
   * verification), and returns their storage keys for the caller's
   * post-commit file deletion. No filesystem operation occurs inside this
   * transaction. Fails closed (returns `{cleaned:false, reason}`, deletes
   * nothing) for Open, Applied, an unexpected status, or a missing/stale
   * audit timestamp - never throws for these expected, retryable outcomes.
   */
  deleteRetentionEligibleStagedPhotosLocked(
    intakeId: string,
    request: AiIntakeRetentionCleanupRequest,
    remainingBudget: number,
  ): Promise<AiIntakeRetentionCleanupResult>;

  /** Used by the canonical orphan sweep's mandatory staged-source-row protection check (H). */
  existsStagedPhotoById(photoId: string): Promise<boolean>;
  /** Used by the private orphan sweep's ownership check. */
  existsStagedPhotoByStorageKey(storageKey: string): Promise<boolean>;
  /** Used by the canonical orphan sweep's ProductPhoto-row ownership check. */
  existsProductPhotoByIdAndProductId(photoId: string, productId: string): Promise<boolean>;
  /** Used by the canonical orphan sweep's active-outbox-event protection check. */
  hasNonTerminalProductPhotoOutboxEvent(photoId: string): Promise<boolean>;
}
