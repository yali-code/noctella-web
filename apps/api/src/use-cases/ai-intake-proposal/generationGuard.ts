/**
 * Sprint 103: a narrow, in-process, per-intake mutual-exclusion guard around
 * one AI Intake generation attempt (provider call + persistence). This is
 * NOT a database lock, NOT a lease, NOT a queue - it exists solely to
 * prevent two concurrent /generate requests for the SAME intake from both
 * reaching a paid AI provider before either one's write completes (the
 * existing atomic persistence guard in repositories/ai-intake-proposal/drizzle.ts
 * already makes a duplicate proposal row impossible; this guard exists only
 * to avoid a duplicate paid provider call, a cost concern, never a data-
 * integrity one - see the Sprint 102/103 discovery reports).
 *
 * Contains no timers, no lease/expiry, no persisted state, and no network or
 * database behavior - a process restart or crash clears every held claim for
 * free, by construction, so no stale-claim recovery mechanism is needed or
 * provided. Reused exclusively by generateOrRegenerateProposalUseCase
 * (../ai-intake-proposal/useCases.ts).
 */
const activeIntakeIds = new Set<string>();

/**
 * Synchronously and atomically tries to claim the guard for one intake id -
 * there is no await between the check and the set, so under Node's single-
 * threaded execution model no other call can interleave between them.
 * Returns true if the claim succeeded (the caller now holds it and MUST
 * call releaseGenerationGuard for this id, typically in a finally block);
 * returns false if another attempt already holds it - the caller must
 * reject immediately. Never waits, never queues, never polls.
 */
export function tryAcquireGenerationGuard(intakeId: string): boolean {
  if (activeIntakeIds.has(intakeId)) return false;
  activeIntakeIds.add(intakeId);
  return true;
}

/** Idempotent - safe to call even if the guard was never held for this id. */
export function releaseGenerationGuard(intakeId: string): void {
  activeIntakeIds.delete(intakeId);
}
