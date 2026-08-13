import { z } from "zod";

/**
 * Sprint 140: the Admin never supplies a canonical machine key directly - only a free-text
 * label, canonicalized server-side (services/marketingTags.ts). No arbitrary length cap per
 * Architecture Review - no existing repository/validation convention constrains Marketing Tag
 * text length, so none is invented here.
 */
export const addProductMarketingTagSchema = z.object({
  label: z.string().min(1, "Label is required"),
});

export type AddProductMarketingTagInput = z.infer<typeof addProductMarketingTagSchema>;
