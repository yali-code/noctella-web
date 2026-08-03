export type AiDraftRecord = Record<string, string | number | boolean | null>;
export interface AiDraftApprovalConflict { field: "id" | "status"; message: string }
export interface AiDraftApprovalClaimResult { updated: boolean; row?: AiDraftRecord; conflict?: AiDraftApprovalConflict }
export interface AiDraftApprovalClaimInput {
  id: string;
  reviewedByAdminUserId: string;
  reviewedAt: string;
  updatedAt: string;
}

/**
 * Sprint 89: narrow, approval-only repository for ai_listing_drafts - not a
 * general-purpose AI Draft repository. Used exclusively inside the approval
 * transaction (see use-cases/ai-draft/useCases.ts); generation/update/reject/
 * list continue to use raw Drizzle in services/aiDrafts.ts, unchanged.
 */
export interface AiDraftApprovalRepository {
  findById(id: string): Promise<AiDraftRecord | null>;
  /**
   * Atomic conditional claim: UPDATE ... WHERE id = ? AND status = 'pending_review'.
   * Zero affected rows means either not-found or already non-PendingReview
   * (a lost concurrent-approval race) - conflict.field distinguishes the two.
   */
  claimAndApprove(input: AiDraftApprovalClaimInput): Promise<AiDraftApprovalClaimResult>;
}

export type SynchronousAiDraftApprovalRepository = {
  [Key in keyof AiDraftApprovalRepository]: AiDraftApprovalRepository[Key] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result
    : AiDraftApprovalRepository[Key];
};
