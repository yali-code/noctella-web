import { z } from "zod";
import { AI_DRAFT_STATUS_VALUES } from "@noctella/shared";

/** Reviewer id is optional for now — full admin auth enforcement is a later sprint. */
export const generateDraftSchema = z.object({
  reviewedByAdminUserId: z.string().optional(),
});

export const updateDraftSchema = z.object({
  generatedTitle: z.string().optional(),
  generatedDescription: z.string().optional(),
  generatedStory: z.string().optional(),
  generatedConditionDescription: z.string().optional(),
  suggestedCategoryId: z.string().optional(),
  suggestedCollectionId: z.string().optional(),
  suggestedEurPrice: z.number().positive("Suggested EUR price must be greater than 0").optional(),
  suggestedUsdPrice: z.number().positive("Suggested USD price must be greater than 0").optional(),
  suggestedMinimumOfferPrice: z.number().min(0, "Minimum offer price cannot be negative").optional(),
  seoTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  shippingNote: z.string().optional(),
  customsWarning: z.boolean().optional(),
});

export const approveDraftSchema = z.object({
  reviewedByAdminUserId: z.string().optional(),
});

export const rejectDraftSchema = z.object({
  rejectionReason: z.string().min(1, "Rejection reason is required"),
  reviewedByAdminUserId: z.string().optional(),
});

export const regenerateDraftSchema = z.object({
  reviewedByAdminUserId: z.string().optional(),
});

export const aiDraftListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(AI_DRAFT_STATUS_VALUES as [string, ...string[]]).optional(),
});

export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type RejectDraftInput = z.infer<typeof rejectDraftSchema>;
export type AiDraftListQuery = z.infer<typeof aiDraftListQuerySchema>;
