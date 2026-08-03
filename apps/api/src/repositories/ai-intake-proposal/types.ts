export type AiIntakeProposalRecord = Record<string, string | number | boolean | Date | null>;

export interface AiIntakeProposalCreateInput {
  id: string;
  intakeId: string;
  /** Fingerprint computed from the same photo read used to build the generation context, before the provider was called. */
  expectedPhotoFingerprint: string;
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  suggestedKeywords: string | null; // JSON-encoded string[]
  confidenceScore: number | null;
  generatedAt: string;
  providerName: string;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiIntakeProposalRefreshInput {
  id: string;
  intakeId: string;
  expectedUpdatedAt: string;
  /** Fingerprint computed from the same photo read used to build the generation context, before the provider was called. */
  expectedPhotoFingerprint: string;
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  suggestedKeywords: string | null;
  confidenceScore: number | null;
  generatedAt: string;
  providerName: string;
  promptVersion: string;
  updatedAt: string;
}

export type AiIntakeProposalField = "title" | "description" | "keywords";

/**
 * Business decision for a single field review, computed by the caller (the
 * use-case layer) and handed to the repository's updateFieldReviewAtomic so
 * the decision logic stays out of the repository while still running inside
 * the same locked transaction as the read it was based on.
 */
export interface AiIntakeProposalFieldReviewDecision {
  decision: string;
  value: string | null; // pre-serialized for keywords (JSON string)
  reviewedByAdminUserId: string | null;
  reviewedAt: string | null;
  updatedAt: string;
}

export type AiIntakeProposalConflictReason =
  | "intake_not_found"
  | "intake_not_open"
  | "proposal_already_exists"
  | "version_mismatch"
  | "review_not_pending"
  | "photo_context_changed";

export interface AiIntakeProposalConflict {
  reason: AiIntakeProposalConflictReason;
  message: string;
}

export interface AiIntakeProposalWriteResult {
  updated: boolean;
  row?: AiIntakeProposalRecord;
  conflict?: AiIntakeProposalConflict;
}

/**
 * Sprint 93 correction pass: every write locks the related ai_product_intakes
 * row first (see services/aiIntakeLockTransactionCapabilityForDb.ts) and
 * re-verifies both intake status and photo-set fingerprint from a fresh read
 * taken inside that same lock - a service-layer pre-check alone is never
 * sufficient, and neither is an unlocked read-then-write sequence.
 */
export interface AiIntakeProposalRepository {
  findByIntakeId(intakeId: string): Promise<AiIntakeProposalRecord | null>;
  insertIfAbsentAndIntakeOpen(input: AiIntakeProposalCreateInput): Promise<AiIntakeProposalWriteResult>;
  refreshPendingFields(input: AiIntakeProposalRefreshInput): Promise<AiIntakeProposalWriteResult>;
  /**
   * Locks the intake row, re-reads the proposal by id, verifies
   * expectedUpdatedAt and the photo-set fingerprint against the proposal's
   * stored baseline, then invokes `decide` with the freshly-read row so the
   * caller can compute the write payload (or throw a validation error, e.g.
   * for an Accepted decision with no valid suggestion) using data that is
   * provably current as of the write.
   */
  updateFieldReviewAtomic(
    intakeId: string,
    proposalId: string,
    field: AiIntakeProposalField,
    expectedUpdatedAt: string,
    decide: (existing: AiIntakeProposalRecord) => AiIntakeProposalFieldReviewDecision,
  ): Promise<AiIntakeProposalWriteResult>;
}
