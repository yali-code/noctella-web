import { z } from "zod";
import { PublishChannel } from "@noctella/shared";
import type { MarketplacePreparationProposal } from "./types";

/**
 * Sprint 107: the exact suggestion fields requested per channel - kept as
 * one map so the JSON Schema builder, the Zod schema builder, and the
 * response-mapping function below can never drift out of sync with each
 * other, and so the model is never asked for a field irrelevant to the
 * selected channel (matching the approved field-ownership scope exactly -
 * no ebayCategory, no marketplace price, nothing outside Sprint 107's
 * approved scope).
 */
const CHANNEL_FIELDS: Record<PublishChannel, readonly (keyof MarketplacePreparationProposal)[]> = {
  [PublishChannel.Ebay]: ["suggestedTitle", "suggestedDescription", "suggestedConditionDescription", "suggestedItemSpecifics"],
  [PublishChannel.Etsy]: ["suggestedTitle", "suggestedDescription", "suggestedTags", "suggestedMaterials", "suggestedStyle", "suggestedOccasion"],
  [PublishChannel.NoctellaWeb]: [
    "suggestedTitle",
    "suggestedDescription",
    "suggestedShortDescription",
    "suggestedSeoTitle",
    "suggestedMetaDescription",
    "suggestedFocusKeyword",
  ],
};

const ARRAY_FIELDS = new Set<keyof MarketplacePreparationProposal>(["suggestedTags"]);

/**
 * Sprint 107: the exact JSON Schema sent to OpenAI's Responses API Structured
 * Outputs (`text.format`) for one channel. OpenAI's strict structured-output
 * mode requires every property listed in `properties` to also appear in
 * `required` - "optional" fields are represented as nullable types instead
 * of omitted keys, mirroring ai-intake/openAiOutputSchema.ts's established
 * convention exactly.
 */
export function buildMarketplacePreparationOpenAiResponseJsonSchema(channel: PublishChannel) {
  const fields = CHANNEL_FIELDS[channel];
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    properties[field] = ARRAY_FIELDS.has(field) ? { type: ["array", "null"], items: { type: "string" } } : { type: ["string", "null"] };
  }
  return {
    type: "object",
    properties,
    required: [...fields],
    additionalProperties: false,
  } as const;
}

/**
 * Sprint 107: builds the Zod validation schema for one generation request,
 * mirroring buildMarketplacePreparationOpenAiResponseJsonSchema's shape
 * exactly - raw model JSON is never passed directly into a
 * MarketplacePreparationGenerationResult regardless of what the JSON Schema
 * above already constrained it to. `.strict()` rejects any additional
 * property the model might still emit despite `additionalProperties: false`
 * above - defense in depth, not reliance on the provider alone.
 */
export function buildMarketplacePreparationOpenAiResponseZodSchema(channel: PublishChannel) {
  const fields = CHANNEL_FIELDS[channel];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field] = ARRAY_FIELDS.has(field) ? z.array(z.string()).nullable() : z.string().nullable();
  }
  return z.object(shape).strict();
}

export type MarketplacePreparationOpenAiResponse = Record<string, string | string[] | null>;

function emptyToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Sprint 107: maps the validated, nullable, channel-scoped OpenAI response
 * into the existing optional-field MarketplacePreparationProposal contract
 * (./types.ts) - null/blank becomes undefined (never an empty string or
 * empty array, matching MockMarketplacePreparationProvider's own
 * convention). Only ever populates the fields requested for the given
 * channel - every other MarketplacePreparationProposal field is left
 * undefined.
 */
export function toMarketplacePreparationProposal(channel: PublishChannel, response: MarketplacePreparationOpenAiResponse): MarketplacePreparationProposal {
  const proposal: MarketplacePreparationProposal = {};
  for (const field of CHANNEL_FIELDS[channel]) {
    const raw = response[field];
    if (ARRAY_FIELDS.has(field)) {
      const values = raw as string[] | null;
      const normalized = values?.map((v) => v.trim()).filter((v) => v.length > 0);
      (proposal as Record<string, unknown>)[field] = normalized && normalized.length > 0 ? normalized : undefined;
    } else {
      (proposal as Record<string, unknown>)[field] = emptyToUndefined(raw as string | null);
    }
  }
  return proposal;
}
