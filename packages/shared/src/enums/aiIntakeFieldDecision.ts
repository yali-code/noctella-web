/** Sprint 93: per-field human review decision on an AiProductIntake's generated proposal. */
export enum AiIntakeFieldDecision {
  Pending = "pending",
  Accepted = "accepted",
  Edited = "edited",
  Rejected = "rejected",
}

export const AI_INTAKE_FIELD_DECISION_VALUES: AiIntakeFieldDecision[] = Object.values(AiIntakeFieldDecision);
