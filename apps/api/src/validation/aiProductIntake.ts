import { z } from "zod";
import { AI_PRODUCT_INTAKE_STATUS_VALUES } from "@noctella/shared";

/**
 * Sprint 90: creator identity comes only from the authenticated session
 * (req.adminUser.id) - never from the request body. A strict empty object
 * rejects any body field, including a client-supplied createdByAdminUserId
 * or any other unknown field, mirroring approveDraftSchema (Sprint 89).
 */
export const createAiProductIntakeSchema = z.object({}).strict();

export const aiProductIntakeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(AI_PRODUCT_INTAKE_STATUS_VALUES as [string, ...string[]]).optional(),
});

/**
 * cancelledByAdminUserId is never accepted - identity comes only from
 * req.adminUser.id. Strict so any unknown field, including a spoofed actor
 * id, is rejected rather than silently stripped.
 */
export const cancelAiProductIntakeSchema = z
  .object({
    cancellationReason: z.string().trim().min(1).optional(),
  })
  .strict();

export type AiProductIntakeListQuery = z.infer<typeof aiProductIntakeListQuerySchema>;
export type CancelAiProductIntakeInput = z.infer<typeof cancelAiProductIntakeSchema>;
