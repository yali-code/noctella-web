import { z } from "zod";

/**
 * Sprint 96: dryRun is required (never optional/defaulted) - every caller
 * must be explicit about intent, matching the rollout discipline the
 * approved architecture requires. Strict, so any unknown field - a path,
 * filename, storage key, Product/ProductPhoto id, intake status, retention
 * timestamp, actor id, process-start value, or client-supplied cursor - is
 * rejected outright rather than silently stripped. batchSize is bounded
 * [1,500] at the schema level; the service additionally clamps defensively
 * (see services/aiIntakeCleanup.ts) so a bypass of this schema can never
 * exceed the approved maximum either.
 */
export const aiIntakeCleanupRunSchema = z
  .object({
    dryRun: z.boolean(),
    batchSize: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export type AiIntakeCleanupRunInput = z.infer<typeof aiIntakeCleanupRunSchema>;
