import { z } from "zod";
import type { AiIntakeProposal } from "./types";

/**
 * Sprint 106: every plain, nullable, string-valued suggestion field the AI
 * may populate - kept as one list so the JSON Schema builder and the Zod
 * schema builder below can never drift out of sync with each other.
 * suggestedCategoryId is deliberately NOT in this list - it needs its own
 * per-request `enum` constraint (built from the caller's allowed category
 * ids), not a plain nullable string.
 */
const NULLABLE_STRING_SUGGESTION_FIELDS = [
  "suggestedTitle",
  "suggestedDescription",
  "suggestedBrand",
  "suggestedModel",
  "suggestedManufacturer",
  "suggestedCountryOfOrigin",
  "suggestedPeriod",
  "suggestedMaterials",
  "suggestedCondition",
  "suggestedConditionDescription",
  "suggestedSeoTitle",
  "suggestedMetaDescription",
] as const;

/**
 * Sprint 101: the exact JSON Schema sent to OpenAI's Responses API Structured
 * Outputs (`text.format`). OpenAI's strict structured-output mode requires
 * every property listed in `properties` to also appear in `required` -
 * "optional" fields are represented as nullable types instead of omitted
 * keys.
 *
 * Sprint 106: expanded from the original title/description/keywords/
 * confidenceScore-only shape to cover the approved AI Full Product Analysis
 * field set - still intentionally the smallest shape that maps onto the
 * existing AiIntakeProposal contract (./types.ts). No price, stock, SKU,
 * barcode, physical measurement, weight, shipping, merchandising, or
 * marketplace-specific field is requested here - the AI Intake proposal
 * contract has never had one for those, and the approved architecture keeps
 * AI out of authority over all of them.
 *
 * `allowedCategoryIds` constrains `suggestedCategoryId` to exactly the
 * existing, real category ids supplied by the caller (services/
 * aiIntakeGeneration.ts, sourced unchanged from services/categories.ts) via
 * a JSON Schema `enum` - the model can never invent a category id, only
 * choose one of these or return null. An empty list (no categories exist)
 * degenerates to "must be null", never a crash.
 */
export function buildAiIntakeOpenAiResponseJsonSchema(allowedCategoryIds: string[]) {
  const properties: Record<string, unknown> = {
    suggestedKeywords: { type: ["array", "null"], items: { type: "string" } },
    // Sprint 101 correction: constrained to the valid [0,1] range at the schema level (both here
    // and in the Zod schema below) - an out-of-range value is invalid structured output, not a
    // value to silently clamp/repair.
    confidenceScore: { type: ["number", "null"], minimum: 0, maximum: 1 },
    suggestedCategoryId: { type: ["string", "null"], enum: [...allowedCategoryIds, null] },
    // Sprint 106: priceEur is a recommendation only (never authoritative) - still schema-bounded
    // to a non-negative value, matching confidenceScore's own never-silently-repaired discipline.
    suggestedPriceEur: { type: ["number", "null"], minimum: 0 },
  };
  for (const field of NULLABLE_STRING_SUGGESTION_FIELDS) properties[field] = { type: ["string", "null"] };

  return {
    type: "object",
    properties,
    required: [...NULLABLE_STRING_SUGGESTION_FIELDS, "suggestedKeywords", "confidenceScore", "suggestedCategoryId", "suggestedPriceEur"],
    additionalProperties: false,
  } as const;
}

/**
 * Sprint 106: builds the Zod validation schema for one generation request,
 * mirroring buildAiIntakeOpenAiResponseJsonSchema's shape exactly - raw model
 * JSON is never passed directly into an AiIntakeGenerationResult regardless
 * of what the JSON Schema above already constrained it to.
 * `.strict()` rejects any additional property the model might still emit
 * despite `additionalProperties: false` above - defense in depth, not
 * reliance on the provider alone. suggestedCategoryId is validated against
 * the SAME allowedCategoryIds list passed to the JSON Schema builder -
 * z.enum requires at least one literal, so an empty allow-list falls back to
 * a schema that only accepts null.
 */
export function buildAiIntakeOpenAiResponseZodSchema(allowedCategoryIds: string[]) {
  const categoryIdSchema =
    allowedCategoryIds.length > 0 ? z.enum(allowedCategoryIds as [string, ...string[]]).nullable() : z.null();

  const shape: Record<string, z.ZodTypeAny> = {
    suggestedKeywords: z.array(z.string()).nullable(),
    confidenceScore: z.number().min(0).max(1).nullable(),
    suggestedCategoryId: categoryIdSchema,
    suggestedPriceEur: z.number().min(0).nullable(),
  };
  for (const field of NULLABLE_STRING_SUGGESTION_FIELDS) shape[field] = z.string().nullable();

  return z.object(shape).strict();
}

export type AiIntakeOpenAiResponse = z.infer<ReturnType<typeof buildAiIntakeOpenAiResponseZodSchema>>;

function emptyToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Sprint 106 (correction pass): maps the validated, nullable OpenAI response
 * into the existing optional-field AiIntakeProposal contract (./types.ts) -
 * null/blank becomes undefined (never an empty string or empty array,
 * matching MockAiIntakeGenerationProvider's own convention). confidenceScore
 * and suggestedPriceEur are passed through as-is (never clamped/repaired) -
 * the Zod schema above already rejects any value outside its valid range
 * before this function is ever called, so a value reaching here is already
 * guaranteed valid. Never broadens AiIntakeProposal itself.
 */
export function toAiIntakeProposal(response: AiIntakeOpenAiResponse): AiIntakeProposal {
  const r = response as Record<string, string | number | string[] | null>;
  const suggestedKeywords = r.suggestedKeywords as string[] | null;
  const normalizedKeywords = suggestedKeywords && suggestedKeywords.map((k) => k.trim()).filter((k) => k.length > 0);

  return {
    suggestedTitle: emptyToUndefined(r.suggestedTitle as string | null),
    suggestedDescription: emptyToUndefined(r.suggestedDescription as string | null),
    suggestedKeywords: normalizedKeywords && normalizedKeywords.length > 0 ? normalizedKeywords : undefined,
    confidenceScore: r.confidenceScore === null ? undefined : (r.confidenceScore as number),
    suggestedCategoryId: emptyToUndefined(r.suggestedCategoryId as string | null),
    suggestedBrand: emptyToUndefined(r.suggestedBrand as string | null),
    suggestedModel: emptyToUndefined(r.suggestedModel as string | null),
    suggestedManufacturer: emptyToUndefined(r.suggestedManufacturer as string | null),
    suggestedCountryOfOrigin: emptyToUndefined(r.suggestedCountryOfOrigin as string | null),
    suggestedPeriod: emptyToUndefined(r.suggestedPeriod as string | null),
    suggestedMaterials: emptyToUndefined(r.suggestedMaterials as string | null),
    suggestedCondition: emptyToUndefined(r.suggestedCondition as string | null),
    suggestedConditionDescription: emptyToUndefined(r.suggestedConditionDescription as string | null),
    suggestedSeoTitle: emptyToUndefined(r.suggestedSeoTitle as string | null),
    suggestedMetaDescription: emptyToUndefined(r.suggestedMetaDescription as string | null),
    suggestedPriceEur: r.suggestedPriceEur === null ? undefined : (r.suggestedPriceEur as number),
  };
}
