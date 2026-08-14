import { z } from "zod";
import { CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS } from "@noctella/shared";

/** Sprint 148: Generate takes no request body - mirrors validation/marketplacePreparation.ts's generateMarketplacePreparationSchema shape, minus the channel (canonical proposals are never channel-scoped). `.strict()` rejects any unknown field. */
export const generateCanonicalProductProposalSchema = z.object({}).strict();

/**
 * Sprint 148: Architecture Review item J - the Accept request must carry an explicit allowlisted
 * selection of canonical Product field keys, never "apply every suggested field". `z.enum` over
 * the shared CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS tuple rejects any unrecognized field name
 * outright (defense layer 1 - the use-case's own allowlist intersection, layer 2). Marketing Tag
 * selections are plain trimmed strings here; the use-case intersects them against the proposal's
 * own stored suggestedMarketingTags, so an arbitrary client-supplied label can never be injected.
 * At least one of the two selections must be non-empty - Accept with nothing selected is a
 * request-shape error, not a valid no-op.
 */
export const acceptCanonicalProductProposalSchema = z
  .object({
    expectedProposalUpdatedAt: z.string().min(1, "expectedProposalUpdatedAt is required"),
    selectedProductFields: z.array(z.enum(CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS)).default([]),
    selectedMarketingTags: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .refine((data) => data.selectedProductFields.length > 0 || data.selectedMarketingTags.length > 0, {
    message: "Select at least one suggested field or Marketing Tag to accept.",
    path: ["selectedProductFields"],
  });

export type GenerateCanonicalProductProposalInput = z.infer<typeof generateCanonicalProductProposalSchema>;
export type AcceptCanonicalProductProposalInput = z.infer<typeof acceptCanonicalProductProposalSchema>;
