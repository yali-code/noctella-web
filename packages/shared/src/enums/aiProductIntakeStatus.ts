/**
 * Sprint 90: intake foundation only. Applied (Sprint 94) and any other
 * lifecycle state are deliberately not added here until their owning sprint
 * implements the behavior that makes them reachable.
 */
export enum AiProductIntakeStatus {
  Open = "open",
  Cancelled = "cancelled",
}

export const AI_PRODUCT_INTAKE_STATUS_VALUES: AiProductIntakeStatus[] = Object.values(AiProductIntakeStatus);
