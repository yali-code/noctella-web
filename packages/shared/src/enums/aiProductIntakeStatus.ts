/**
 * Sprint 90: Open, Cancelled. Sprint 94: Applied - the terminal state set
 * once Save as Draft has created the canonical Product/Inventory and written
 * resultProductId. Sprint 95: Finalized - the complete AI Product Intake
 * workflow's terminal result, set once staged photos have been promoted into
 * canonical ProductPhoto rows for the applied Product. A future Sprint 96
 * cleanup pass may act on a Finalized intake's staged photos without
 * changing this status. Any further lifecycle state is deliberately not
 * added here until its owning sprint implements the behavior that makes it
 * reachable.
 */
export enum AiProductIntakeStatus {
  Open = "open",
  Cancelled = "cancelled",
  Applied = "applied",
  Finalized = "finalized",
}

export const AI_PRODUCT_INTAKE_STATUS_VALUES: AiProductIntakeStatus[] = Object.values(AiProductIntakeStatus);
