import { z } from "zod";
import type { AiIntakeProposal } from "./types";

/**
 * Sprint 101: the exact JSON Schema sent to OpenAI's Responses API Structured
 * Outputs (`text.format`). OpenAI's strict structured-output mode requires
 * every property listed in `properties` to also appear in `required` -
 * "optional" fields are represented as nullable types instead of omitted
 * keys. This is intentionally the smallest shape that still maps onto the
 * existing AiIntakeProposal contract (./types.ts) - suggestedTitle /
 * suggestedDescription / suggestedKeywords / confidenceScore only, nothing
 * else. No price, stock, SKU, category, brand, model, or condition field is
 * requested here - the AI Intake proposal contract has never had one.
 */
export const AI_INTAKE_OPENAI_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    suggestedTitle: { type: ["string", "null"] },
    suggestedDescription: { type: ["string", "null"] },
    suggestedKeywords: { type: ["array", "null"], items: { type: "string" } },
    // Sprint 101 correction: constrained to the valid [0,1] range at the schema level (both here
    // and in the Zod schema below) - an out-of-range value is invalid structured output, not a
    // value to silently clamp/repair.
    confidenceScore: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
  required: ["suggestedTitle", "suggestedDescription", "suggestedKeywords", "confidenceScore"],
  additionalProperties: false,
} as const;

/**
 * Sprint 101: validates the parsed JSON body of OpenAI's structured output
 * before it is ever trusted - raw model JSON is never passed directly into
 * an AiIntakeGenerationResult. Nullable (not optional) fields, mirroring the
 * strict JSON Schema above exactly. `.strict()` rejects any additional
 * property the model might still emit despite `additionalProperties: false`
 * above - defense in depth, not reliance on the provider alone.
 */
export const aiIntakeOpenAiResponseSchema = z
  .object({
    suggestedTitle: z.string().nullable(),
    suggestedDescription: z.string().nullable(),
    suggestedKeywords: z.array(z.string()).nullable(),
    // Sprint 101 correction: a numeric confidenceScore outside [0,1] fails validation here (and
    // therefore the whole response) rather than being silently clamped by the mapper below.
    confidenceScore: z.number().min(0).max(1).nullable(),
  })
  .strict();

export type AiIntakeOpenAiResponse = z.infer<typeof aiIntakeOpenAiResponseSchema>;

function emptyToUndefined(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Sprint 101 (correction pass): maps the validated, nullable OpenAI response
 * into the existing optional-field AiIntakeProposal contract (./types.ts) -
 * null/blank becomes undefined (never an empty string or empty array,
 * matching MockAiIntakeGenerationProvider's own convention). confidenceScore
 * is passed through as-is (never clamped/repaired) - aiIntakeOpenAiResponseSchema
 * above already rejects any value outside [0,1] before this function is ever
 * called, so a value reaching here is already guaranteed valid. Never
 * broadens AiIntakeProposal itself.
 */
export function toAiIntakeProposal(response: AiIntakeOpenAiResponse): AiIntakeProposal {
  const suggestedKeywords =
    response.suggestedKeywords && response.suggestedKeywords.map((k) => k.trim()).filter((k) => k.length > 0);

  return {
    suggestedTitle: emptyToUndefined(response.suggestedTitle),
    suggestedDescription: emptyToUndefined(response.suggestedDescription),
    suggestedKeywords: suggestedKeywords && suggestedKeywords.length > 0 ? suggestedKeywords : undefined,
    confidenceScore: response.confidenceScore === null ? undefined : response.confidenceScore,
  };
}
