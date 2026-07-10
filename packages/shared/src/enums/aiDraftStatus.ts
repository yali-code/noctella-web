export enum AiDraftStatus {
  Generating = "generating",
  PendingReview = "pending_review",
  Approved = "approved",
  Rejected = "rejected",
  Superseded = "superseded",
  Failed = "failed",
}

export const AI_DRAFT_STATUS_VALUES: AiDraftStatus[] = Object.values(AiDraftStatus);
