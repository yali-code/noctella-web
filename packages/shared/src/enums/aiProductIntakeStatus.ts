/**
 * Sprint 90: Open, Cancelled. Sprint 94: Applied - the terminal state set
 * once Save as Draft has created the canonical Product/Inventory and written
 * resultProductId. Any further lifecycle state is deliberately not added
 * here until its owning sprint implements the behavior that makes it
 * reachable.
 */
export enum AiProductIntakeStatus {
  Open = "open",
  Cancelled = "cancelled",
  Applied = "applied",
}

export const AI_PRODUCT_INTAKE_STATUS_VALUES: AiProductIntakeStatus[] = Object.values(AiProductIntakeStatus);
