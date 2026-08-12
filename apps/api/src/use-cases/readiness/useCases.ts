/**
 * Sprint 135: pure business-readiness evaluation - no I/O, no environment access, no database
 * access. Every input is passed in already-resolved by services/readiness.ts, so this function
 * stays trivially testable and free of any authoritative-vs-presentation ambiguity. Deliberately
 * separate from GET /health (process liveness only, unchanged by this sprint) - this answers
 * "can this system safely serve real COD production traffic right now," not "is the process up."
 */
export interface ReadinessInput {
  /** True only when at least one shipping_methods row has isActive=true - see repositories/shipping. Does not evaluate country/profile suitability for any specific catalog; that remains an operator go-live checklist concern (see docs/deployment). */
  hasActiveShippingMethod: boolean;
  /** From payments/paymentService.ts's stripePublicCheckoutEnabled - must be false for a COD-only launch. */
  stripePublicCheckoutEnabled: boolean;
  /** From payments/paymentService.ts's mockPaymentsEnabled - must be false; a real production launch must never accept a mock "always succeeds" payment. */
  mockPaymentsEnabled: boolean;
  adminAppOriginConfigured: boolean;
  storefrontAppOriginConfigured: boolean;
}

export interface ReadinessChecks {
  shippingConfigured: boolean;
  stripePublicCheckoutDisabled: boolean;
  mockPaymentsDisabled: boolean;
  adminAppOriginConfigured: boolean;
  storefrontAppOriginConfigured: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  checks: ReadinessChecks;
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const checks: ReadinessChecks = {
    shippingConfigured: input.hasActiveShippingMethod,
    stripePublicCheckoutDisabled: !input.stripePublicCheckoutEnabled,
    mockPaymentsDisabled: !input.mockPaymentsEnabled,
    adminAppOriginConfigured: input.adminAppOriginConfigured,
    storefrontAppOriginConfigured: input.storefrontAppOriginConfigured,
  };
  const ready = Object.values(checks).every(Boolean);
  return { ready, checks };
}
