import { z } from "zod";
import { DIMENSION_UNIT_VALUES, WEIGHT_UNIT_VALUES } from "@noctella/shared";
import { normalizeDimensionToCanonical, normalizeWeightToCanonical } from "./measurementNormalization";
import type { CanonicalProductProposal } from "./types";

/**
 * Sprint 148: the exact suggestion fields requested from the model - kept as one list so the JSON
 * Schema builder, the Zod schema builder, and the response-mapping function below can never drift
 * out of sync, mirroring marketplace-prep/openAiOutputSchema.ts's own CHANNEL_FIELDS precedent.
 */
const TEXT_FIELDS = [
  "suggestedBrand",
  "suggestedModel",
  "suggestedManufacturer",
  "suggestedCountryOfOrigin",
  "suggestedPeriod",
  "suggestedMaterials",
  "suggestedDescription",
  "suggestedProductStory",
  "suggestedCondition",
  "suggestedConditionDescription",
] as const;

/**
 * Sprint 148: the exact JSON Schema sent to OpenAI's Responses API Structured Outputs
 * (`text.format`). OpenAI's strict structured-output mode requires every property listed in
 * `properties` to also appear in `required` - "optional" fields are nullable types, mirroring
 * ai-intake/openAiOutputSchema.ts and marketplace-prep/openAiOutputSchema.ts's established
 * convention exactly. suggestedDimensionUnit/suggestedWeightUnit are constrained to the existing
 * canonical enum values ONLY - the model is structurally unable to emit a raw unit like "mm"/"g",
 * which is what forces it to self-normalize or omit (see promptBuilder.ts's explicit instruction).
 */
export function buildCanonicalProductProposalOpenAiResponseJsonSchema() {
  const properties: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) properties[field] = { type: ["string", "null"] };
  properties.suggestedLengthValue = { type: ["number", "null"] };
  properties.suggestedWidthValue = { type: ["number", "null"] };
  properties.suggestedHeightValue = { type: ["number", "null"] };
  properties.suggestedDimensionUnit = { type: ["string", "null"], enum: [...DIMENSION_UNIT_VALUES, null] };
  properties.suggestedWeightValue = { type: ["number", "null"] };
  properties.suggestedWeightUnit = { type: ["string", "null"], enum: [...WEIGHT_UNIT_VALUES, null] };
  properties.suggestedMarketingTags = { type: ["array", "null"], items: { type: "string" } };

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}

/**
 * Sprint 148: builds the Zod validation schema mirroring
 * buildCanonicalProductProposalOpenAiResponseJsonSchema's shape exactly - raw model JSON is never
 * passed directly into a CanonicalProductProposalGenerationResult regardless of what the JSON
 * Schema above already constrained it to. `.strict()` rejects any additional property the model
 * might still emit despite `additionalProperties: false` above - defense in depth, not reliance
 * on the provider alone.
 */
export function buildCanonicalProductProposalOpenAiResponseZodSchema() {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of TEXT_FIELDS) shape[field] = z.string().nullable();
  shape.suggestedLengthValue = z.number().nullable();
  shape.suggestedWidthValue = z.number().nullable();
  shape.suggestedHeightValue = z.number().nullable();
  shape.suggestedDimensionUnit = z.enum(DIMENSION_UNIT_VALUES as [string, ...string[]]).nullable();
  shape.suggestedWeightValue = z.number().nullable();
  shape.suggestedWeightUnit = z.enum(WEIGHT_UNIT_VALUES as [string, ...string[]]).nullable();
  shape.suggestedMarketingTags = z.array(z.string()).nullable();
  return z.object(shape).strict();
}

export type CanonicalProductProposalOpenAiResponse = Record<string, string | number | string[] | null>;

function emptyToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface RawPhysicalSuggestion {
  lengthValue: number | null;
  widthValue: number | null;
  heightValue: number | null;
  dimensionUnit: string | null;
  weightValue: number | null;
  weightUnit: string | null;
}

export interface SanitizedPhysicalSuggestion {
  suggestedLengthValue?: number;
  suggestedWidthValue?: number;
  suggestedHeightValue?: number;
  suggestedDimensionUnit?: string;
  suggestedWeightValue?: number;
  suggestedWeightUnit?: string;
}

/**
 * Sprint 148: the physical-field safety net (Architecture Review items E/F/G), independently
 * unit-testable. Rules, applied in order:
 *   1. imagesUsedCount === 0 -> every physical field omitted, unconditionally, regardless of what
 *      the provider returned (no image evidence can exist without an image).
 *   2. Each of length/width/height is only kept when BOTH that value AND dimensionUnit are
 *      present - an incomplete/ambiguous unit-value pair is dropped, never guessed.
 *   3. Weight is only kept when BOTH weightValue AND weightUnit are present, same rule.
 *   4. Each kept value is passed through normalizeDimensionToCanonical/normalizeWeightToCanonical
 *      - negative or non-finite values are dropped (return null -> field omitted); this also
 *      re-confirms canonical-unit rounding even though the JSON Schema enum already constrains
 *      the unit to cm|in / kg|lb.
 * A malformed/dropped physical field never affects Product Details or Marketing Tags - this
 * function only ever touches the physical subset.
 */
export function sanitizeCanonicalPhysicalSuggestion(raw: RawPhysicalSuggestion, imagesUsedCount: number): SanitizedPhysicalSuggestion {
  if (imagesUsedCount <= 0) return {};

  const result: SanitizedPhysicalSuggestion = {};
  let dimensionUnitUsed: "cm" | "in" | undefined;

  if (raw.dimensionUnit !== null) {
    for (const [rawValue, key] of [
      [raw.lengthValue, "suggestedLengthValue"],
      [raw.widthValue, "suggestedWidthValue"],
      [raw.heightValue, "suggestedHeightValue"],
    ] as const) {
      if (rawValue === null) continue;
      const normalized = normalizeDimensionToCanonical(rawValue, raw.dimensionUnit);
      if (!normalized) continue;
      (result as Record<string, number>)[key] = normalized.value;
      dimensionUnitUsed = normalized.unit;
    }
  }
  if (dimensionUnitUsed) result.suggestedDimensionUnit = dimensionUnitUsed;

  if (raw.weightValue !== null && raw.weightUnit !== null) {
    const normalized = normalizeWeightToCanonical(raw.weightValue, raw.weightUnit);
    if (normalized) {
      result.suggestedWeightValue = normalized.value;
      result.suggestedWeightUnit = normalized.unit;
    }
  }

  return result;
}

/**
 * Sprint 148: maps the validated OpenAI response into the CanonicalProductProposal contract
 * (./types.ts) - null/blank becomes undefined. imagesUsedCount is threaded through to
 * sanitizeCanonicalPhysicalSuggestion so the "no image -> no physical suggestion" rule is
 * enforced here regardless of what the model itself returned.
 */
export function toCanonicalProductProposal(response: CanonicalProductProposalOpenAiResponse, imagesUsedCount: number): CanonicalProductProposal {
  const proposal: CanonicalProductProposal = {};
  for (const field of TEXT_FIELDS) {
    (proposal as Record<string, unknown>)[field] = emptyToUndefined(response[field] as string | null);
  }

  const physical = sanitizeCanonicalPhysicalSuggestion(
    {
      lengthValue: response.suggestedLengthValue as number | null,
      widthValue: response.suggestedWidthValue as number | null,
      heightValue: response.suggestedHeightValue as number | null,
      dimensionUnit: response.suggestedDimensionUnit as string | null,
      weightValue: response.suggestedWeightValue as number | null,
      weightUnit: response.suggestedWeightUnit as string | null,
    },
    imagesUsedCount,
  );
  Object.assign(proposal, physical);

  const rawTags = response.suggestedMarketingTags as string[] | null;
  const normalizedTags = rawTags?.map((t) => t.trim()).filter((t) => t.length > 0);
  proposal.suggestedMarketingTags = normalizedTags && normalizedTags.length > 0 ? Array.from(new Set(normalizedTags)) : undefined;

  return proposal;
}
