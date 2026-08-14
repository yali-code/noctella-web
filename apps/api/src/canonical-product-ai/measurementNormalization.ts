/**
 * Sprint 148: pure, stateless measurement-normalization helpers - the exact arithmetic the AI
 * system prompt (./promptBuilder.ts) instructs the model to perform itself before emitting a
 * value (canonical output is always cm|in / kg|lb, enforced by the OpenAI structured-output JSON
 * Schema enum in ./openAiOutputSchema.ts). Reused here as a defensive, deterministic
 * double-check on any already-canonical-unit value the provider returns, and directly unit-tested
 * on its own to prove the conversion math (85 mm -> 8.5 cm, 350 g -> 0.35 kg) independent of any
 * network call. Never introduces a new persisted unit - the return type is always one of the
 * existing DimensionUnit/WeightUnit enum values, never mm/g/oz/m.
 */

const DECIMALS = 3;
function round(value: number): number {
  return Math.round(value * 10 ** DECIMALS) / 10 ** DECIMALS;
}

/**
 * Accepts a value plus a source unit (canonical cm/in, or a commonly-confused raw unit mm/m) and
 * returns the equivalent in cm or in - or null if the value is not a finite non-negative number,
 * or the source unit cannot be reliably mapped to a canonical dimension unit (ambiguous unit ->
 * omit, never guess, per Architecture Review item F).
 */
export function normalizeDimensionToCanonical(value: number, sourceUnit: string): { value: number; unit: "cm" | "in" } | null {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  const unit = sourceUnit.trim().toLowerCase();
  if (unit === "cm") return { value: round(v), unit: "cm" };
  if (unit === "mm") return { value: round(v / 10), unit: "cm" };
  if (unit === "m") return { value: round(v * 100), unit: "cm" };
  if (unit === "in" || unit === "inch" || unit === "inches") return { value: round(v), unit: "in" };
  return null;
}

/**
 * Accepts a value plus a source unit (canonical kg/lb, or a commonly-confused raw unit g/oz) and
 * returns the equivalent in kg or lb - or null under the same non-negative/ambiguous-unit rules
 * as normalizeDimensionToCanonical above.
 */
export function normalizeWeightToCanonical(value: number, sourceUnit: string): { value: number; unit: "kg" | "lb" } | null {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  const unit = sourceUnit.trim().toLowerCase();
  if (unit === "kg") return { value: round(v), unit: "kg" };
  if (unit === "g") return { value: round(v / 1000), unit: "kg" };
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") return { value: round(v), unit: "lb" };
  if (unit === "oz" || unit === "ounce" || unit === "ounces") return { value: round(v / 16), unit: "lb" };
  return null;
}
