import { z } from "zod";
import { baseProductSchema } from "./product";

/**
 * Sprint 94: strict Save as Draft request. Reuses the exact canonical
 * Product field validators (sku/categoryId/type/priceEur/stockQuantity) via
 * .pick() on baseProductSchema, rather than re-declaring equivalent rules -
 * title/description/keywords are read server-side from the durable
 * proposal, never accepted here; Product status, actor identity, and
 * resultProductId are always server-controlled and never accepted from the
 * client. expectedProposalUpdatedAt is the only Sprint-94-specific field.
 */
export const saveAiIntakeAsDraftSchema = baseProductSchema
  .pick({ sku: true, categoryId: true, type: true, priceEur: true, stockQuantity: true })
  .extend({ expectedProposalUpdatedAt: z.string().min(1, "expectedProposalUpdatedAt is required") })
  .strict();

export type SaveAiIntakeAsDraftInput = z.infer<typeof saveAiIntakeAsDraftSchema>;
