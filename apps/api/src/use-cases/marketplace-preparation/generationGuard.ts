/**
 * Sprint 107: a narrow, in-process, per-(productId, channel) mutual-exclusion
 * guard around one marketplace-preparation generation attempt (provider call
 * + persistence). Mirrors use-cases/ai-intake-proposal/generationGuard.ts's
 * exact shape and reasoning, deliberately as a new, separate module rather
 * than importing that one - it is explicitly documented as scoped/reused
 * exclusively by the AI Intake domain, and its key space (intake ids) is
 * semantically unrelated to this domain's (productId:channel composite
 * keys). This is NOT a database lock, NOT a lease, NOT a queue - it exists
 * solely to prevent two concurrent generate requests for the SAME product
 * and channel from both reaching a paid AI provider before either one's
 * write completes (the upsert itself is always safe/idempotent regardless -
 * this guard exists only to avoid a duplicate paid provider call, a cost
 * concern, never a data-integrity one).
 *
 * Contains no timers, no lease/expiry, no persisted state, and no network or
 * database behavior - a process restart or crash clears every held claim for
 * free, by construction, so no stale-claim recovery mechanism is needed or
 * provided. Reused exclusively by generateMarketplacePreparationUseCase
 * (./useCases.ts).
 */
const activeKeys = new Set<string>();

function key(productId: string, channel: string): string {
  return `${productId}:${channel}`;
}

/**
 * Synchronously and atomically tries to claim the guard for one
 * (productId, channel) pair - there is no await between the check and the
 * set, so under Node's single-threaded execution model no other call can
 * interleave between them. Returns true if the claim succeeded (the caller
 * now holds it and MUST call releaseMarketplacePreparationGenerationGuard
 * for this pair, typically in a finally block); returns false if another
 * attempt already holds it. A concurrent request for the SAME product but a
 * DIFFERENT channel always succeeds - independent keys, independent claims.
 */
export function tryAcquireMarketplacePreparationGenerationGuard(productId: string, channel: string): boolean {
  const k = key(productId, channel);
  if (activeKeys.has(k)) return false;
  activeKeys.add(k);
  return true;
}

/** Idempotent - safe to call even if the guard was never held for this pair. */
export function releaseMarketplacePreparationGenerationGuard(productId: string, channel: string): void {
  activeKeys.delete(key(productId, channel));
}
