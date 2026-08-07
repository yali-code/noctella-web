import { z } from "zod";
import { publishChannelSchema } from "./publishing";

/**
 * Sprint 107: reuses validation/publishing.ts's existing publishChannelSchema
 * (PUBLISH_CHANNEL_VALUES-derived) - never a duplicated channel enum. Strict
 * so any unknown field is rejected, not silently stripped.
 */
export const generateMarketplacePreparationSchema = z.object({ channel: publishChannelSchema }).strict();

export const getMarketplacePreparationQuerySchema = z.object({ channel: publishChannelSchema });

/**
 * Sprint 107: the admin-reviewed/edited final field values, submitted
 * directly at approval time - mirrors Stock Acceptance's exact established
 * contract (validation/aiIntakeStockAcceptance.ts). Every field is optional
 * (only the ones relevant to the selected channel are ever read server-side
 * - see use-cases/marketplace-preparation/useCases.ts's
 * mapApprovedFieldsToProductValues). Strict so an unknown field - including
 * a client-supplied sku/status/stockQuantity/collectionId - is rejected, not
 * silently stripped.
 */
export const approveMarketplacePreparationSchema = z
  .object({
    channel: publishChannelSchema,
    expectedProposalUpdatedAt: z.string().min(1, "expectedProposalUpdatedAt is required"),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    conditionDescription: z.string().trim().min(1).optional(),
    itemSpecifics: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    materials: z.string().trim().min(1).optional(),
    style: z.string().trim().min(1).optional(),
    occasion: z.string().trim().min(1).optional(),
    shortDescription: z.string().trim().min(1).optional(),
    seoTitle: z.string().trim().min(1).optional(),
    metaDescription: z.string().trim().min(1).optional(),
    focusKeyword: z.string().trim().min(1).optional(),
  })
  .strict();

export type GenerateMarketplacePreparationInput = z.infer<typeof generateMarketplacePreparationSchema>;
export type GetMarketplacePreparationQuery = z.infer<typeof getMarketplacePreparationQuerySchema>;
export type ApproveMarketplacePreparationInput = z.infer<typeof approveMarketplacePreparationSchema>;
