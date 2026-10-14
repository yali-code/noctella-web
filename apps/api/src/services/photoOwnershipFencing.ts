/**
 * Photo-operation ownership fencing switch and fail-closed refusals (#396/#403/#407).
 *
 * PHOTO_OWNERSHIP_FENCING_ENABLED is OFF unless exactly "true". When OFF, every writer and
 * deleter behaves exactly as before. When ON, only adopted writers may mutate canonical photo
 * storage; every unadopted canonical writer or deleter refuses instead of writing or deleting:
 *   W1 legacy upload, W2 staged upload (and therefore W10 rollback deletion): HTTP 503
 *   W6 AI cleanup canonical deletion: refused, counted as a failure, nothing deleted
 *   W7 promotion with distinct temp/permanent roots: refused (same-root promotion only checks files)
 *   W8 canonical delete / W9 temp cleanup outbox events: permanent refusal -> dead-lettered for
 *      operator review, nothing deleted
 *   W11 Instagram derivatives/temporaries in the canonical root: retryable refusal
 * W4 AI deterministic finalization is the adopted writer (services/aiIntakePhotoFencedFinalization.ts).
 * Turning the flag ON requires the operator runbook (old instances stopped, outbox drained).
 */

export const photoOwnershipFencingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PHOTO_OWNERSHIP_FENCING_ENABLED === "true";

export type UnadoptedPhotoWriter = "W1_LEGACY_UPLOAD" | "W2_STAGED_UPLOAD" | "W6_AI_CLEANUP_CANONICAL_DELETE" | "W7_DISTINCT_ROOT_PROMOTION" | "W8_CANONICAL_DELETE" | "W9_TEMP_CLEANUP" | "W11_INSTAGRAM_DERIVATIVE";

/** Permanent (outbox dead-letters it with this code; nothing is retried into a deletion). */
export class PhotoFencingRefusedError extends Error {
  readonly permanent = true;
  readonly code = "PHOTO_FENCING_WRITER_NOT_ADOPTED";
  constructor(readonly writer: UnadoptedPhotoWriter) {
    super(`Photo ownership fencing is enabled; ${writer} is not adopted and was refused without mutating storage`);
  }
}

export function refuseUnadoptedPhotoWriter(writer: UnadoptedPhotoWriter, env: NodeJS.ProcessEnv = process.env): void {
  if (photoOwnershipFencingEnabled(env)) throw new PhotoFencingRefusedError(writer);
}

/**
 * Rollback guard for the additive ownership tables (migration 0040 / schema.sql). Dropping them
 * discards ownership evidence, so it is refused while any operation is still preparing, sealed
 * or under review. Pass the rows of OWNERSHIP_ROLLBACK_BLOCKERS_SQL.
 */
export const OWNERSHIP_ROLLBACK_BLOCKERS_SQL = "SELECT state, COUNT(*) AS n FROM photo_operations WHERE state IN ('preparing', 'sealed', 'review') GROUP BY state ORDER BY state";
export function ownershipRollbackBlockers(rows: Array<{ state: string; n: number | string }>): { safe: boolean; blockers: Record<string, number> } {
  const blockers: Record<string, number> = {};
  for (const row of rows) {
    const n = Number(row.n);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("PHOTO_OWNERSHIP_ROLLBACK_STATE_UNREADABLE");
    if (n > 0) blockers[row.state] = n;
  }
  return { safe: Object.keys(blockers).length === 0, blockers };
}
