import { z } from "zod";
import type { SalesEnrichmentResult } from "./types";

/**
 * Sprint 140: the exact JSON Schema sent to OpenAI's Responses API Structured Outputs
 * (`text.format`) - a single array-of-strings field, nothing else. Mirrors
 * marketplace-prep/openAiOutputSchema.ts's exact "strict, closed schema" convention.
 */
export function buildSalesEnrichmentOpenAiResponseJsonSchema() {
  return {
    type: "object",
    properties: {
      marketingTags: { type: "array", items: { type: "string" } },
    },
    required: ["marketingTags"],
    additionalProperties: false,
  } as const;
}

/**
 * Sprint 140: raw model JSON is never passed directly into a SalesEnrichmentResult regardless of
 * what the JSON Schema above already constrained it to. `.strict()` rejects any additional
 * property the model might still emit - defense in depth, not reliance on the provider alone.
 */
export function buildSalesEnrichmentOpenAiResponseZodSchema() {
  return z.object({ marketingTags: z.array(z.string()) }).strict();
}

export type SalesEnrichmentOpenAiResponse = { marketingTags: string[] };

export function toSalesEnrichmentResult(response: SalesEnrichmentOpenAiResponse): SalesEnrichmentResult {
  const marketingTags = response.marketingTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return { marketingTags };
}
