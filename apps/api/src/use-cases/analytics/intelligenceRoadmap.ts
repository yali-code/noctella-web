/**
 * Analytics Stage 3 PR-2: deterministic evidence fusion + advisory roadmap (pure). Combines
 * existing outputs only - catalogue profitability/insights (Phase 1B-1E), external platform
 * analytics, social analytics, experiment results and Knowledge Memory. It never recalculates
 * accounting and never executes anything: every item is advisory with an owner-approval route.
 *
 * Permanent evidence priority (1 = strongest): verified Noctella transactions > verified platform
 * analytics > Noctella experiments > authoritative external > multi-source market > community >
 * single weak opinion. Strength is categorical, never a fake-precision score.
 */

export const EVIDENCE_TIERS = {
  NOCTELLA_TRANSACTION: 1,
  PLATFORM_ANALYTICS: 2,
  NOCTELLA_EXPERIMENT: 3,
  AUTHORITATIVE_EXTERNAL: 4,
  MULTI_SOURCE_MARKET: 5,
  COMMUNITY_SIGNAL: 6,
  SINGLE_WEAK_OPINION: 7,
} as const;
export type EvidenceTier = keyof typeof EVIDENCE_TIERS;
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
export type RoadmapType = "PROVEN_ACTION" | "TEST_NEXT" | "WATCH" | "RISK" | "DATA_GAP";
export type Horizon = "TODAY" | "THIS_WEEK" | "THIS_MONTH" | "WATCHLIST" | "RISKS";
export const HORIZONS: readonly Horizon[] = ["TODAY", "THIS_WEEK", "THIS_MONTH", "WATCHLIST", "RISKS"];

const STRENGTH_ORDER: EvidenceStrength[] = ["INSUFFICIENT", "WEAK", "MODERATE", "STRONG"];

/**
 * STRONG: verified internal/platform data corroborated by a Noctella experiment.
 * MODERATE: verified Noctella or platform data, or a Noctella experiment, on its own.
 * WEAK: authoritative or multi-source external information only.
 * INSUFFICIENT: community signals / single weak opinions only, or no evidence.
 * A relevant business-data gap lowers the strength by one level.
 */
export function evidenceStrength(tiers: readonly EvidenceTier[], options: { dataGap?: boolean } = {}): EvidenceStrength {
  const ranks = tiers.map((t) => EVIDENCE_TIERS[t]);
  const best = ranks.length ? Math.min(...ranks) : 99;
  let strength: EvidenceStrength = (ranks.some((r) => r <= 2) && ranks.includes(3)) ? "STRONG" : best <= 3 ? "MODERATE" : best <= 5 ? "WEAK" : "INSUFFICIENT";
  if (options.dataGap) strength = STRENGTH_ORDER[Math.max(0, STRENGTH_ORDER.indexOf(strength) - 1)]!;
  return strength;
}

export interface RoadmapEvidence { readonly tier: EvidenceTier; readonly source: string; readonly fact: string; readonly value: string | number | boolean | null }
export interface RoadmapItem {
  readonly key: string;
  readonly type: RoadmapType;
  readonly horizon: Horizon;
  readonly title: string;
  readonly affected: { readonly platform?: string; readonly categories?: readonly string[]; readonly productIds?: readonly string[] };
  readonly evidence: readonly RoadmapEvidence[];
  readonly evidenceStrength: EvidenceStrength;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  readonly reason: string;
  readonly suggestedNextAction: string;
  /** Metadata only - nothing is executed. Every route requires owner approval. */
  readonly executionRoute: { readonly department: "FINANCE" | "PRICING" | "INVENTORY" | "SOURCING" | "SALES" | "MEDIA" | "OPERATIONS"; readonly approval: "OWNER_APPROVAL_REQUIRED" };
  readonly blockers: readonly string[];
  readonly advisoryOnly: true;
}

export interface IntelligenceInputs {
  readonly now: Date;
  readonly catalogue: { readonly byProfitStatus: Readonly<Record<string, number>>; readonly productsWithInsight: Readonly<Record<string, number>>; readonly policyGaps: readonly string[]; readonly sold: number };
  readonly social: { readonly mapped: number; readonly unmapped: number; readonly entities: number };
  readonly providerBlockers: Readonly<Record<string, readonly string[]>>;
  readonly researchProviderConfigured: boolean;
  readonly experiments: readonly {
    readonly id: string; readonly title: string; readonly domain: string; readonly platform: string | null; readonly categories: readonly string[]; readonly sourceFindingId: string | null; readonly status: string;
    readonly result: { readonly resultState: string; readonly winningVariant: string | null; readonly confidenceLevel: string; readonly bestPractice: "CURRENT" | "REVALIDATION_DUE" | null } | null;
  }[];
  readonly findings: readonly {
    readonly id: string; readonly topicDomain: string; readonly topic: string; readonly claim: string; readonly classification: string; readonly sourceQuality: string; readonly sourceDomain: string;
    readonly freshness: string; readonly category: string | null; readonly platform: string | null; readonly businessRelevance: string;
  }[];
  readonly openConflicts: readonly { readonly id: string; readonly findingAId: string; readonly findingBId: string }[];
}

const QUALITY_TIER: Record<string, EvidenceTier> = { A: "AUTHORITATIVE_EXTERNAL", B: "MULTI_SOURCE_MARKET", C: "COMMUNITY_SIGNAL", D: "SINGLE_WEAK_OPINION" };
const confidenceOf = (s: EvidenceStrength) => (s === "STRONG" ? "HIGH" : s === "MODERATE" ? "MEDIUM" : s === "WEAK" ? "LOW" : "INSUFFICIENT") as RoadmapItem["confidence"];

export function buildRoadmap(input: IntelligenceInputs) {
  const items: RoadmapItem[] = [];
  const profitabilityGap = (input.catalogue.byProfitStatus.INCOMPLETE ?? 0) > 0 || input.catalogue.policyGaps.length > 0;
  const add = (item: Omit<RoadmapItem, "evidenceStrength" | "confidence" | "advisoryOnly">, dataGap = false) => {
    const strength = evidenceStrength(item.evidence.map((e) => e.tier), { dataGap });
    items.push({ ...item, evidenceStrength: strength, confidence: confidenceOf(strength), advisoryOnly: true });
  };
  const route = (department: RoadmapItem["executionRoute"]["department"]) => ({ department, approval: "OWNER_APPROVAL_REQUIRED" as const });
  const count = (code: string) => input.catalogue.productsWithInsight[code] ?? 0;

  // DATA_GAP: missing business data suppresses margin-driven recommendations.
  if (profitabilityGap) {
    add({ key: "DATA_GAP:profitability", type: "DATA_GAP", horizon: "TODAY", title: "Profitability is incomplete; margin-based recommendations are suppressed", affected: {},
      evidence: [{ tier: "NOCTELLA_TRANSACTION", source: "catalogue", fact: "byProfitStatus.INCOMPLETE", value: input.catalogue.byProfitStatus.INCOMPLETE ?? 0 }, ...input.catalogue.policyGaps.map((g) => ({ tier: "NOCTELLA_TRANSACTION" as const, source: "catalogue", fact: "policyGap", value: g }))],
      reason: "Unknown financial components (e.g. payment fees) keep known profit, margin and ROI unavailable.", suggestedNextAction: "Supply the missing fee/shipping/cost data or an owner fee rule.", executionRoute: route("FINANCE"), blockers: [...input.catalogue.policyGaps] });
  }
  if (count("COST_BASIS_MISSING") > 0) add({ key: "DATA_GAP:cost_basis", type: "DATA_GAP", horizon: "THIS_WEEK", title: `${count("COST_BASIS_MISSING")} product(s) have no acquisition cost`, affected: {}, evidence: [{ tier: "NOCTELLA_TRANSACTION", source: "catalogue", fact: "productsWithInsight.COST_BASIS_MISSING", value: count("COST_BASIS_MISSING") }], reason: "Without a cost basis, profitability cannot be assessed.", suggestedNextAction: "Record or verify acquisition costs.", executionRoute: route("FINANCE"), blockers: [] });
  if (input.social.unmapped > 0) add({ key: "DATA_GAP:social_mapping", type: "DATA_GAP", horizon: "THIS_MONTH", title: `${input.social.unmapped} social item(s) are not linked to a product`, affected: {}, evidence: [{ tier: "PLATFORM_ANALYTICS", source: "social", fact: "unmapped", value: input.social.unmapped }], reason: "Unmapped social performance cannot be compared with business results.", suggestedNextAction: "Publish through the Noctella publishing chain or link Pins to storefront product URLs.", executionRoute: route("MEDIA"), blockers: [] });

  // RISK: measured internal problems and operational/platform blockers.
  if (count("NEGATIVE_PROFIT") > 0) add({ key: "RISK:negative_profit", type: "RISK", horizon: "TODAY", title: `${count("NEGATIVE_PROFIT")} sale(s) show a loss`, affected: {}, evidence: [{ tier: "NOCTELLA_TRANSACTION", source: "catalogue", fact: "productsWithInsight.NEGATIVE_PROFIT", value: count("NEGATIVE_PROFIT") }], reason: "Available profitability data indicates loss-making sales.", suggestedNextAction: "Review the affected sales' economics before repeating similar pricing or sourcing.", executionRoute: route("PRICING"), blockers: [] }, profitabilityGap);
  if (count("AGED_INVENTORY") > 0) add({ key: "RISK:aged_inventory", type: "RISK", horizon: "THIS_WEEK", title: `${count("AGED_INVENTORY")} item(s) exceed the inventory-age threshold`, affected: {}, evidence: [{ tier: "NOCTELLA_TRANSACTION", source: "catalogue", fact: "productsWithInsight.AGED_INVENTORY", value: count("AGED_INVENTORY") }], reason: "Capital is tied up in slow-moving stock.", suggestedNextAction: "Review aged items; consider a controlled listing or pricing experiment.", executionRoute: route("INVENTORY"), blockers: [] });
  for (const [provider, blockers] of Object.entries(input.providerBlockers)) {
    if (blockers.length === 0) continue;
    add({ key: `RISK:provider:${provider}`, type: "RISK", horizon: "RISKS", title: `${provider} analytics is not available`, affected: { platform: provider }, evidence: blockers.map((b) => ({ tier: "PLATFORM_ANALYTICS" as const, source: `${provider}.readiness`, fact: "blocker", value: b })), reason: "Platform evidence for this channel cannot be collected.", suggestedNextAction: "Complete the provider activation steps.", executionRoute: route("OPERATIONS"), blockers: [...blockers] });
  }
  if (!input.researchProviderConfigured) add({ key: "RISK:research_provider", type: "RISK", horizon: "RISKS", title: "Web research provider is not activated", affected: {}, evidence: [{ tier: "SINGLE_WEAK_OPINION", source: "knowledge", fact: "researchProviderConfigured", value: false }], reason: "Twice-monthly external research cannot run automatically.", suggestedNextAction: "Activate an approved web search provider or ingest vetted research manually.", executionRoute: route("OPERATIONS"), blockers: ["WEB_SEARCH_PROVIDER_ACTIVATION_REQUIRED"] });

  // Experiments: only Noctella-validated winners become PROVEN_ACTION.
  const testedFindings = new Set(input.experiments.map((e) => e.sourceFindingId).filter(Boolean));
  for (const e of input.experiments) {
    const r = e.result;
    if (!r) continue;
    const affected = { platform: e.platform ?? undefined, categories: e.categories };
    const evidence: RoadmapEvidence[] = [{ tier: "NOCTELLA_EXPERIMENT", source: `experiment:${e.id}`, fact: "resultState", value: r.resultState }, { tier: "NOCTELLA_EXPERIMENT", source: `experiment:${e.id}`, fact: "confidenceLevel", value: r.confidenceLevel }];
    if (r.resultState === "WINNER" && r.bestPractice === "CURRENT" && (r.confidenceLevel === "HIGH" || r.confidenceLevel === "MEDIUM")) {
      add({ key: `PROVEN_ACTION:experiment:${e.id}`, type: "PROVEN_ACTION", horizon: "THIS_WEEK", title: `Apply the winning variant ${r.winningVariant} of "${e.title}"`, affected, evidence, reason: "A Noctella experiment produced a winner with adequate confidence and passed its guardrails.", suggestedNextAction: "Approve rollout through the responsible department's normal workflow.", executionRoute: route(e.domain === "pricing" ? "PRICING" : e.domain === "sourcing" ? "SOURCING" : e.domain === "social_content" ? "MEDIA" : "SALES"), blockers: [] });
    } else if (r.resultState === "WINNER") {
      add({ key: `TEST_NEXT:revalidate:${e.id}`, type: "TEST_NEXT", horizon: "THIS_MONTH", title: `Re-test "${e.title}"`, affected, evidence, reason: r.bestPractice === "REVALIDATION_DUE" ? "The best practice is due for revalidation." : "The winner's confidence is too low to treat as proven.", suggestedNextAction: "Run a follow-up experiment with the same fixed success metric.", executionRoute: route("SALES"), blockers: [] });
    } else if (r.resultState === "INCONCLUSIVE" || r.resultState === "REJECTED") {
      add({ key: `WATCH:experiment:${e.id}`, type: "WATCH", horizon: "WATCHLIST", title: `"${e.title}" did not produce an adoptable winner (${r.resultState})`, affected, evidence, reason: r.resultState === "REJECTED" ? "The leading variant violated a guardrail." : "Evidence was insufficient for a decision.", suggestedNextAction: "Keep the current practice; revisit with more data if still relevant.", executionRoute: route("SALES"), blockers: [] });
    }
  }

  // Knowledge: external information is never adopted directly - TEST_NEXT or WATCH only.
  for (const f of input.findings) {
    if (f.freshness === "STALE" || f.freshness === "SUPERSEDED") continue;
    const tier = QUALITY_TIER[f.sourceQuality] ?? "SINGLE_WEAK_OPINION";
    const evidence: RoadmapEvidence[] = [{ tier, source: f.sourceDomain, fact: `${f.classification}:${f.topic}`, value: f.claim }];
    const affected = { platform: f.platform ?? undefined, categories: f.category ? [f.category] : undefined };
    if (f.topicDomain === "RISK" && f.classification === "FACT") {
      add({ key: `RISK:finding:${f.id}`, type: "RISK", horizon: "RISKS", title: f.claim, affected, evidence, reason: "Authoritative external change that may affect operations.", suggestedNextAction: "Verify impact against Noctella listings, fees and processes.", executionRoute: route("OPERATIONS"), blockers: [] });
    } else if ((f.sourceQuality === "A" || f.sourceQuality === "B") && f.classification !== "COMMUNITY_SENTIMENT" && !testedFindings.has(f.id)) {
      add({ key: `TEST_NEXT:finding:${f.id}`, type: "TEST_NEXT", horizon: "THIS_MONTH", title: `Test: ${f.topic}`, affected, evidence, reason: "External idea not yet validated with Noctella data.", suggestedNextAction: "Register a 2-5 variant experiment with a success metric fixed in advance.", executionRoute: route(f.topicDomain === "SOCIAL" ? "MEDIA" : f.topicDomain === "SOURCING" ? "SOURCING" : "SALES"), blockers: [] });
    } else if (!testedFindings.has(f.id)) {
      add({ key: `WATCH:finding:${f.id}`, type: "WATCH", horizon: "WATCHLIST", title: `Watch: ${f.topic}`, affected, evidence, reason: "Signal only - not verified and not supported by Noctella sales evidence.", suggestedNextAction: "Monitor; compare against Noctella data before acting.", executionRoute: route("SALES"), blockers: [] });
    }
  }
  for (const c of input.openConflicts) {
    add({ key: `WATCH:conflict:${c.id}`, type: "WATCH", horizon: "WATCHLIST", title: "Conflicting external findings", affected: {}, evidence: [{ tier: "MULTI_SOURCE_MARKET", source: "knowledge", fact: "conflict", value: `${c.findingAId} vs ${c.findingBId}` }], reason: "Credible sources disagree; neither is adopted.", suggestedNextAction: "Resolve with Noctella data or an experiment.", executionRoute: route("SALES"), blockers: [] });
  }

  const order = (s: EvidenceStrength) => STRENGTH_ORDER.length - STRENGTH_ORDER.indexOf(s);
  const horizons = Object.fromEntries(HORIZONS.map((h) => [h, items.filter((i) => i.horizon === h).sort((a, b) => order(a.evidenceStrength) - order(b.evidenceStrength) || a.key.localeCompare(b.key))])) as Record<Horizon, RoadmapItem[]>;
  return { generatedAt: input.now.toISOString(), advisoryOnly: true as const, marginRecommendationsSuppressed: profitabilityGap, horizons, counts: Object.fromEntries(HORIZONS.map((h) => [h, horizons[h].length])) };
}
