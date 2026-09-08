import { z } from "zod";

/**
 * Sprint 163: conservative shared scheduler boundary. The canonical cron sends 10,
 * and every scheduler domain must receive the same finite, safe integer without
 * coercion before any work begins.
 */
export const schedulerBatchSizeSchema = z.number().finite().int().min(1).max(10);

const schedulerBatchInputSchema = z.object({
  batchSize: schedulerBatchSizeSchema.default(10),
});

export function parseSchedulerBatchSize(value: unknown): number {
  return schedulerBatchInputSchema.parse({ batchSize: value }).batchSize;
}
