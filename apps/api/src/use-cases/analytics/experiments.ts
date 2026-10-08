import { z } from "zod";

/**
 * Analytics Stage 3 PR-2: experiment registry rules (pure). Lifecycle:
 * external idea -> hypothesis -> test -> measure -> WINNER/INCONCLUSIVE -> current best practice
 * -> revalidate. External information is never accepted as correct without a Noctella test.
 * Advisory only: nothing here changes listings, prices, posts, purchases or products.
 *
 * Noctella sells mostly unique items, so non-randomized evidence styles are allowed but their
 * confidence is capped - a cohort/before-after/sequential comparison never claims causal certainty.
 */

export const EVIDENCE_STYLES = ["exact_ab", "matched_product_cohort", "category_cohort", "before_after", "sequential"] as const;
export const NORMALIZATIONS = ["none", "per_listing_day", "per_impression"] as const;
export const VARIANT_KEYS = ["A", "B", "C", "D", "E"] as const;
export const RESULT_STATES = ["WINNER", "INCONCLUSIVE", "STOPPED", "REJECTED"] as const;
export type ResultState = (typeof RESULT_STATES)[number];
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export type EvidenceStyle = (typeof EVIDENCE_STYLES)[number];

/** Highest confidence each evidence style may ever claim. */
export const EVIDENCE_STYLE_CONFIDENCE_CAP: Readonly<Record<EvidenceStyle, ConfidenceLevel>> = Object.freeze({
  exact_ab: "HIGH",
  matched_product_cohort: "MEDIUM",
  category_cohort: "LOW",
  before_after: "LOW",
  sequential: "LOW",
});
/** A winning practice must be re-tested after this many days. */
export const BEST_PRACTICE_REVALIDATE_DAYS = 90;

const metricKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)?$/, "metric must be namespace.key or key");

export const createExperimentSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    hypothesis: z.string().trim().min(10).max(2000),
    domain: z.enum(["listing", "pricing", "promotion", "social_content", "sourcing", "other"]),
    platform: z.string().trim().min(1).max(40).optional(),
    evidenceStyle: z.enum(EVIDENCE_STYLES),
    normalization: z.enum(NORMALIZATIONS).default("none"),
    primaryMetric: metricKey,
    primaryMetricDirection: z.enum(["increase", "decrease"]),
    minRelativeLift: z.number().gt(0).max(5).default(0.1),
    guardrails: z.array(z.object({ metric: metricKey, operator: z.enum(["min", "max"]), threshold: z.number().finite() }).strict()).max(10).default([]),
    scope: z.object({ categories: z.array(z.string().min(1)).max(50).optional(), productIds: z.array(z.string().min(1)).max(500).optional() }).strict().default({}),
    minDurationDays: z.number().int().min(1).max(365).default(14),
    minObservationsPerVariant: z.number().int().min(1).max(1000).default(3),
    sourceFindingId: z.string().min(1).optional(),
    variants: z.array(z.object({ key: z.enum(VARIANT_KEYS), description: z.string().trim().min(1).max(500), isControl: z.boolean().default(false) }).strict()).min(2, "at least 2 variants").max(5, "at most 5 variants"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.variants.map((v) => v.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "variant keys must be unique", path: ["variants"] });
    if (value.variants.filter((v) => v.isControl).length !== 1) ctx.addIssue({ code: "custom", message: "exactly one control variant is required", path: ["variants"] });
    if (value.guardrails.some((g) => g.metric === value.primaryMetric)) ctx.addIssue({ code: "custom", message: "the primary metric cannot also be a guardrail", path: ["guardrails"] });
  });
export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

export const recordObservationSchema = z
  .object({
    observationKey: z.string().min(1).max(200),
    variantKey: z.enum(VARIANT_KEYS),
    metricKey,
    value: z.number().finite(),
    sampleSize: z.number().int().min(1),
    observedAt: z.string().datetime(),
    sourceReference: z.string().min(1).max(300),
  })
  .strict();
export type RecordObservationInput = z.infer<typeof recordObservationSchema>;

export interface ExperimentDefinition {
  readonly evidenceStyle: EvidenceStyle;
  readonly primaryMetric: string;
  readonly primaryMetricDirection: "increase" | "decrease";
  readonly minRelativeLift: number;
  readonly guardrails: readonly { metric: string; operator: "min" | "max"; threshold: number }[];
  readonly minDurationDays: number;
  readonly minObservationsPerVariant: number;
  readonly startedAt: string | null;
}
export interface ExperimentObservation { readonly variantKey: string; readonly metricKey: string; readonly value: number; readonly sampleSize: number }
export interface ExperimentEvaluation {
  readonly resultState: Exclude<ResultState, "STOPPED">;
  readonly winningVariant: string | null;
  readonly confidenceLevel: ConfidenceLevel;
  readonly evidenceSummary: Readonly<Record<string, unknown>>;
}

const RANK: Record<ConfidenceLevel, number> = { INSUFFICIENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const cap = (level: ConfidenceLevel, max: ConfidenceLevel): ConfidenceLevel => (RANK[level] <= RANK[max] ? level : max);

/** Sample-weighted mean of one metric for one variant; null when no observations exist. */
function aggregate(observations: readonly ExperimentObservation[], variantKey: string, metric: string) {
  const rows = observations.filter((o) => o.variantKey === variantKey && o.metricKey === metric);
  const sample = rows.reduce((t, o) => t + o.sampleSize, 0);
  return { count: rows.length, sample, value: sample > 0 ? rows.reduce((t, o) => t + o.value * o.sampleSize, 0) / sample : null };
}

/**
 * Deterministic evaluation against the metric fixed at creation. INCONCLUSIVE when duration or
 * observations are insufficient or the leader does not beat the runner-up by minRelativeLift;
 * REJECTED when the leader violates (or cannot demonstrate) a guardrail; confidence never exceeds
 * the evidence-style cap.
 */
export function evaluateExperiment(definition: ExperimentDefinition, variantKeys: readonly string[], observations: readonly ExperimentObservation[], now: Date): ExperimentEvaluation {
  const perVariant = Object.fromEntries(variantKeys.map((k) => [k, aggregate(observations, k, definition.primaryMetric)]));
  const summary: Record<string, unknown> = { primaryMetric: definition.primaryMetric, direction: definition.primaryMetricDirection, evidenceStyle: definition.evidenceStyle, perVariant };
  const elapsedDays = definition.startedAt ? (now.getTime() - Date.parse(definition.startedAt)) / 86_400_000 : 0;
  const insufficient = [
    ...(elapsedDays < definition.minDurationDays ? ["MIN_DURATION_NOT_REACHED"] : []),
    ...variantKeys.filter((k) => perVariant[k]!.count < definition.minObservationsPerVariant || perVariant[k]!.value === null).map((k) => `INSUFFICIENT_OBSERVATIONS:${k}`),
  ];
  if (insufficient.length > 0) return { resultState: "INCONCLUSIVE", winningVariant: null, confidenceLevel: "INSUFFICIENT", evidenceSummary: { ...summary, reasons: insufficient } };

  const sign = definition.primaryMetricDirection === "increase" ? 1 : -1;
  const ranked = [...variantKeys].sort((a, b) => sign * (perVariant[b]!.value! - perVariant[a]!.value!) || a.localeCompare(b));
  const leader = ranked[0]!, runnerUp = ranked[1]!;
  const lv = perVariant[leader]!.value!, rv = perVariant[runnerUp]!.value!;
  const lift = rv === 0 ? (lv === 0 ? 0 : Number.POSITIVE_INFINITY) : (sign * (lv - rv)) / Math.abs(rv);
  summary.leader = leader;
  summary.relativeLiftOverRunnerUp = Number.isFinite(lift) ? Math.round(lift * 10_000) / 10_000 : null;
  if (lift < definition.minRelativeLift) return { resultState: "INCONCLUSIVE", winningVariant: null, confidenceLevel: "LOW", evidenceSummary: { ...summary, reasons: ["LIFT_BELOW_MINIMUM"] } };

  const guardrailChecks = definition.guardrails.map((g) => {
    const agg = aggregate(observations, leader, g.metric);
    const passed = agg.value === null ? null : g.operator === "min" ? agg.value >= g.threshold : agg.value <= g.threshold;
    return { ...g, value: agg.value, passed };
  });
  summary.guardrails = guardrailChecks;
  if (guardrailChecks.some((g) => g.passed === false)) return { resultState: "REJECTED", winningVariant: null, confidenceLevel: "MEDIUM", evidenceSummary: { ...summary, reasons: ["GUARDRAIL_VIOLATED"] } };
  if (guardrailChecks.some((g) => g.passed === null)) return { resultState: "INCONCLUSIVE", winningVariant: null, confidenceLevel: "LOW", evidenceSummary: { ...summary, reasons: ["GUARDRAIL_DATA_MISSING"] } };

  const strongSample = variantKeys.every((k) => perVariant[k]!.count >= definition.minObservationsPerVariant * 2 && perVariant[k]!.sample >= 30);
  return { resultState: "WINNER", winningVariant: leader, confidenceLevel: cap(strongSample ? "HIGH" : "MEDIUM", EVIDENCE_STYLE_CONFIDENCE_CAP[definition.evidenceStyle]), evidenceSummary: summary };
}

export function revalidateBy(decidedAt: Date): string {
  return new Date(decidedAt.getTime() + BEST_PRACTICE_REVALIDATE_DAYS * 86_400_000).toISOString();
}

/** A WINNER is current best practice until its revalidation date; afterwards it must be re-tested. */
export function bestPracticeStatus(result: { resultState: string; revalidateBy: string | null }, now: Date): "CURRENT" | "REVALIDATION_DUE" | null {
  if (result.resultState !== "WINNER" || !result.revalidateBy) return null;
  return now.getTime() < Date.parse(result.revalidateBy) ? "CURRENT" : "REVALIDATION_DUE";
}
