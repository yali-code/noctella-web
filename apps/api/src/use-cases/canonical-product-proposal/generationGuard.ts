/**
 * Sprint 148: a narrow, in-process, per-productId mutual-exclusion guard around one canonical
 * Product AI proposal generation attempt (provider call + persistence). Mirrors
 * use-cases/marketplace-preparation/generationGuard.ts's exact shape and reasoning, deliberately
 * a new, separate module rather than importing that one - its key space (productId only, no
 * channel) is semantically different. Not a database lock, not a lease, not a queue - exists
 * solely to prevent two concurrent generate requests for the SAME product from both reaching a
 * paid AI provider before either one's write completes (the upsert itself is always safe/
 * idempotent regardless).
 */
const activeProductIds = new Set<string>();

/** Synchronously and atomically tries to claim the guard for one productId. Returns true if the claim succeeded (caller MUST call releaseCanonicalProductProposalGenerationGuard, typically in a finally block); false if another attempt already holds it. */
export function tryAcquireCanonicalProductProposalGenerationGuard(productId: string): boolean {
  if (activeProductIds.has(productId)) return false;
  activeProductIds.add(productId);
  return true;
}

/** Idempotent - safe to call even if the guard was never held for this productId. */
export function releaseCanonicalProductProposalGenerationGuard(productId: string): void {
  activeProductIds.delete(productId);
}
