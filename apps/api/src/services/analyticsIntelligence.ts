import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import { createSqliteIntelligenceRepository } from "../repositories/analytics/intelligenceSqlite";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
import { bestPracticeStatus, createExperimentSchema, evaluateExperiment, recordObservationSchema, revalidateBy } from "../use-cases/analytics/experiments";
import { buildRoadmap, EVIDENCE_TIERS } from "../use-cases/analytics/intelligenceRoadmap";
import {
  classifySourceQuality, DEFAULT_SOURCE_QUALITY_RULES, findingCandidateSchema, findingConfidence, findingFingerprint, freshness, guardClassification,
  redactExcerpt, RESEARCH_TOPICS, researchPeriodKey, reviewBy, sourceDomain, type ResearchProvider, type SourceQualityRules,
} from "../use-cases/analytics/knowledge";
import { socialPerformanceQuerySchema } from "../use-cases/analytics/socialPerformance";
import { getEbayAnalyticsReadiness } from "./ebayAnalytics";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { getCatalogueProfitability } from "./productProfitability";
import { getSocialAnalyticsReadiness, getSocialPerformance } from "./socialAnalytics";

/**
 * Analytics Stage 3 PR-2: experiment registry, Knowledge Memory, twice-monthly research
 * orchestration, evidence fusion and the advisory roadmap. Writes only analytics_experiment* /
 * knowledge_* tables. Nothing here publishes, prices, purchases, refunds, deletes or edits listings.
 */

const parse = (json: string | null, fallback: any) => { try { return json ? JSON.parse(json) : fallback; } catch { return fallback; } };

// ---------------------------------------------------------------- experiments

export function createExperiment(db: DbClient, raw: unknown, now: Date = new Date()) {
  const input = createExperimentSchema.parse(raw);
  const repo = createSqliteIntelligenceRepository(db);
  if (input.sourceFindingId && !repo.getFinding(input.sourceFindingId)) throw new NotFoundError("Source finding not found");
  const id = randomUUID(), t = now.toISOString();
  repo.insertExperiment(
    { id, title: input.title, hypothesis: input.hypothesis, domain: input.domain, platform: input.platform ?? null, evidenceStyle: input.evidenceStyle, normalization: input.normalization, primaryMetric: input.primaryMetric, primaryMetricDirection: input.primaryMetricDirection, minRelativeLift: input.minRelativeLift, guardrailsJson: JSON.stringify(input.guardrails), scopeJson: JSON.stringify(input.scope), minDurationDays: input.minDurationDays, minObservationsPerVariant: input.minObservationsPerVariant, sourceFindingId: input.sourceFindingId ?? null, status: "draft", createdAt: t, updatedAt: t },
    input.variants.map((variant) => ({ id: randomUUID(), experimentId: id, variantKey: variant.key, description: variant.description, isControl: variant.isControl })),
  );
  return getExperimentView(db, id, now);
}

function requireExperiment(db: DbClient, id: string) {
  const experiment = createSqliteIntelligenceRepository(db).getExperiment(id);
  if (!experiment) throw new NotFoundError("Experiment not found");
  return experiment;
}

export function startExperiment(db: DbClient, id: string, now: Date = new Date()) {
  requireExperiment(db, id);
  if (!createSqliteIntelligenceRepository(db).transition(id, "draft", { status: "running", startedAt: now.toISOString(), updatedAt: now.toISOString() })) throw new ConflictError("Only a draft experiment can be started");
  return getExperimentView(db, id, now);
}

/** Records one observation for the primary metric or a declared guardrail only (no post-hoc metrics). Idempotent per observationKey. */
export function recordExperimentObservation(db: DbClient, id: string, raw: unknown) {
  const input = recordObservationSchema.parse(raw);
  const experiment = requireExperiment(db, id);
  const repo = createSqliteIntelligenceRepository(db);
  const existing = repo.findObservation(id, input.observationKey);
  if (existing) {
    const same = existing.variantKey === input.variantKey && existing.metricKey === input.metricKey && existing.value === input.value && existing.sampleSize === input.sampleSize;
    if (!same) throw new ConflictError("Observation key was already used with different values");
    return { recorded: false, replayed: true };
  }
  if (experiment.status !== "running") throw new ConflictError("Observations can only be recorded for a running experiment");
  if (!repo.listVariants(id).some((v: any) => v.variantKey === input.variantKey)) throw new BadRequestError("Unknown variant");
  const allowed = [experiment.primaryMetric, ...parse(experiment.guardrailsJson, []).map((g: any) => g.metric)];
  if (!allowed.includes(input.metricKey)) throw new BadRequestError("Metric is neither the fixed primary metric nor a declared guardrail");
  repo.insertObservation({ id: randomUUID(), experimentId: id, ...input });
  return { recorded: true, replayed: false };
}

export function stopExperiment(db: DbClient, id: string, now: Date = new Date(), reason = "stopped by owner") {
  requireExperiment(db, id);
  const repo = createSqliteIntelligenceRepository(db);
  if (repo.getResult(id)) return { ...getExperimentView(db, id, now), replayed: true };
  const t = now.toISOString();
  if (!repo.finalize(id, "running", "stopped", { experimentId: id, resultState: "STOPPED", winningVariant: null, confidenceLevel: "INSUFFICIENT", evidenceSummaryJson: JSON.stringify({ reason }), decidedAt: t, revalidateBy: null }, t)) throw new ConflictError("Only a running experiment can be stopped");
  return { ...getExperimentView(db, id, now), replayed: false };
}

/** Deterministic, idempotent finalization against the metric fixed at creation. */
export function finalizeExperiment(db: DbClient, id: string, now: Date = new Date()) {
  const experiment = requireExperiment(db, id);
  const repo = createSqliteIntelligenceRepository(db);
  if (repo.getResult(id)) return { ...getExperimentView(db, id, now), replayed: true };
  if (experiment.status !== "running") throw new ConflictError("Only a running experiment can be finalized");
  if (!experiment.startedAt || now.getTime() - Date.parse(experiment.startedAt) < experiment.minDurationDays * 86_400_000) throw new ConflictError("Minimum experiment duration has not been reached");
  const evaluation = evaluateExperiment(
    { evidenceStyle: experiment.evidenceStyle, primaryMetric: experiment.primaryMetric, primaryMetricDirection: experiment.primaryMetricDirection, minRelativeLift: experiment.minRelativeLift, guardrails: parse(experiment.guardrailsJson, []), minDurationDays: experiment.minDurationDays, minObservationsPerVariant: experiment.minObservationsPerVariant, startedAt: experiment.startedAt },
    repo.listVariants(id).map((v: any) => v.variantKey),
    repo.listObservations(id),
    now,
  );
  const t = now.toISOString();
  repo.finalize(id, "running", "completed", { experimentId: id, resultState: evaluation.resultState, winningVariant: evaluation.winningVariant, confidenceLevel: evaluation.confidenceLevel, evidenceSummaryJson: JSON.stringify(evaluation.evidenceSummary), decidedAt: t, revalidateBy: evaluation.resultState === "WINNER" ? revalidateBy(now) : null }, t);
  return { ...getExperimentView(db, id, now), replayed: false };
}

export function getExperimentView(db: DbClient, id: string, now: Date = new Date()) {
  const repo = createSqliteIntelligenceRepository(db);
  const experiment = requireExperiment(db, id);
  const result = repo.getResult(id);
  return {
    ...experiment,
    guardrails: parse(experiment.guardrailsJson, []),
    scope: parse(experiment.scopeJson, {}),
    variants: repo.listVariants(id).map((v: any) => ({ key: v.variantKey, description: v.description, isControl: Boolean(v.isControl) })),
    observationCount: repo.listObservations(id).length,
    result: result ? { ...result, evidenceSummary: parse(result.evidenceSummaryJson, {}), bestPractice: bestPracticeStatus(result, now) } : null,
  };
}

export function listExperimentsView(db: DbClient, now: Date = new Date()) {
  const experiments = createSqliteIntelligenceRepository(db).listExperiments().map((e: any) => getExperimentView(db, e.id, now));
  return {
    experiments,
    currentBestPractices: experiments.filter((e: any) => e.result?.bestPractice).map((e: any) => ({ experimentId: e.id, title: e.title, domain: e.domain, platform: e.platform, scope: e.scope, winningVariant: e.result.winningVariant, confidenceLevel: e.result.confidenceLevel, status: e.result.bestPractice, revalidateBy: e.result.revalidateBy })),
  };
}

// ---------------------------------------------------------------- knowledge memory + research

/** No web search provider ships with Noctella; activation is an explicit owner step. */
export function getConfiguredResearchProvider(_env: NodeJS.ProcessEnv = process.env): ResearchProvider | null {
  return null;
}
export class ResearchProviderNotConfiguredError extends Error {
  readonly code = "WEB_SEARCH_PROVIDER_ACTIVATION_REQUIRED";
  constructor() { super("WEB_SEARCH_PROVIDER_ACTIVATION_REQUIRED"); this.name = "ResearchProviderNotConfiguredError"; }
}

/**
 * Validates, classifies and stores research findings with provenance. Idempotent per
 * (period, provider): a repeated run is replayed. Invalid candidates are rejected individually
 * (with reasons) and never stored.
 */
export function ingestResearchFindings(db: DbClient, input: { provider: string; candidates: readonly unknown[]; now?: Date; periodKey?: string; rules?: SourceQualityRules }) {
  const now = input.now ?? new Date();
  const periodKey = input.periodKey ?? researchPeriodKey(now);
  const repo = createSqliteIntelligenceRepository(db);
  const idempotencyKey = `research:${periodKey}:${input.provider}`;
  const existing = repo.findRun(idempotencyKey);
  if (existing?.status === "completed") return { run: existing, replayed: true, newFindings: 0, confirmedFindings: 0, superseded: 0, conflicts: 0, rejected: [] as { index: number; reason: string }[] };

  const runId = randomUUID(), t = now.toISOString();
  const ops = { inserts: [] as any[], confirmations: [] as { id: string }[], supersede: [] as string[], conflicts: [] as { id: string; a: string; b: string }[] };
  const rejected: { index: number; reason: string }[] = [];
  const seen = new Set<string>();
  input.candidates.forEach((raw, index) => {
    const parsed = findingCandidateSchema.safeParse(raw);
    if (!parsed.success) { rejected.push({ index, reason: parsed.error.issues[0]?.message ?? "invalid" }); return; }
    const c = parsed.data;
    const fingerprint = findingFingerprint(c.topicDomain, c.claim, c.sourceUrl);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    const known = repo.findFindingByFingerprint(fingerprint);
    if (known) { ops.confirmations.push({ id: known.id }); return; }
    if (c.relation && !repo.getFinding(c.relation.findingId)) { rejected.push({ index, reason: "related finding not found" }); return; }
    const quality = classifySourceQuality(c.sourceUrl, c.sourceType, input.rules ?? DEFAULT_SOURCE_QUALITY_RULES);
    const classification = guardClassification(c.classification, quality);
    const id = randomUUID();
    ops.inserts.push({
      id, fingerprint, firstRunId: runId, lastConfirmedRunId: runId, topicDomain: c.topicDomain, topic: c.topic, claim: c.claim, classification,
      category: c.category ?? null, brand: c.brand ?? null, productId: c.productId ?? null, platform: c.platform ?? null,
      sourceUrl: c.sourceUrl, sourceDomain: sourceDomain(c.sourceUrl), sourceType: c.sourceType, sourceQuality: quality, publishedAt: c.publishedAt ?? null,
      collectedAt: t, lastConfirmedAt: t, confidence: findingConfidence(quality, classification), businessRelevance: c.businessRelevance, status: "ACTIVE",
      reviewBy: reviewBy(c.topicDomain, c.publishedAt ?? null, t), evidenceExcerpt: c.excerpt ? redactExcerpt(c.excerpt) : null,
      supersedesFindingId: c.relation?.type === "supersedes" ? c.relation.findingId : null, requiresNoctellaVerification: true, createdAt: t, updatedAt: t,
    });
    if (c.relation?.type === "supersedes") ops.supersede.push(c.relation.findingId);
    if (c.relation?.type === "conflicts") { const [a, b] = [id, c.relation.findingId].sort(); ops.conflicts.push({ id: randomUUID(), a: a!, b: b! }); }
  });
  const run = repo.writeResearchRun({ id: runId, periodKey, provider: input.provider, idempotencyKey, status: "running", startedAt: t }, ops, t);
  return { run, replayed: false, newFindings: ops.inserts.length, confirmedFindings: ops.confirmations.length, superseded: ops.supersede.length, conflicts: ops.conflicts.length, rejected };
}

/** Twice-monthly entry point: requires an approved provider; none exists yet, so it fails closed. */
export async function runWebResearch(db: DbClient, provider: ResearchProvider | null = getConfiguredResearchProvider(), now: Date = new Date()) {
  if (!provider) throw new ResearchProviderNotConfiguredError();
  const periodKey = researchPeriodKey(now);
  const existing = createSqliteIntelligenceRepository(db).findRun(`research:${periodKey}:${provider.name}`);
  if (existing?.status === "completed") return { run: existing, replayed: true };
  const candidates = await provider.research({ periodKey, topics: RESEARCH_TOPICS });
  return ingestResearchFindings(db, { provider: provider.name, candidates, now, periodKey });
}

export function getKnowledgeView(db: DbClient, filters: { topicDomain?: string; classification?: string; status?: string } = {}, now: Date = new Date()) {
  const repo = createSqliteIntelligenceRepository(db);
  const findings = repo.listFindings(filters).map((row: any) => ({ ...row, requiresNoctellaVerification: Boolean(row.requiresNoctellaVerification), freshness: freshness(row, now) }));
  return { findings, conflicts: repo.listConflicts(), meta: { returned: findings.length, researchProviderConfigured: getConfiguredResearchProvider() !== null } };
}

// ---------------------------------------------------------------- evidence fusion + roadmap

function gatherInputs(db: DbClient, now: Date, env: NodeJS.ProcessEnv) {
  const catalogue = getCatalogueProfitability(db, { ...catalogueProfitabilityQuerySchema.parse({}), limit: Number.MAX_SAFE_INTEGER }, now);
  const social = getSocialPerformance(db, socialPerformanceQuerySchema.parse({}));
  const socialSummary = Object.values(social.summary as Record<string, { entities: number; mapped: number; unmapped: number }>).reduce((t, s) => ({ entities: t.entities + s.entities, mapped: t.mapped + s.mapped, unmapped: t.unmapped + s.unmapped }), { entities: 0, mapped: 0, unmapped: 0 });
  const socialReadiness = getSocialAnalyticsReadiness(db, env, now);
  const experiments = listExperimentsView(db, now).experiments.map((e: any) => ({ id: e.id, title: e.title, domain: e.domain, platform: e.platform, categories: e.scope.categories ?? [], sourceFindingId: e.sourceFindingId, status: e.status, result: e.result ? { resultState: e.result.resultState, winningVariant: e.result.winningVariant, confidenceLevel: e.result.confidenceLevel, bestPractice: e.result.bestPractice } : null }));
  const knowledge = getKnowledgeView(db, {}, now);
  return {
    now,
    catalogue: { byProfitStatus: catalogue.summary.byProfitStatus, productsWithInsight: catalogue.summary.productsWithInsight, policyGaps: [...catalogue.meta.policyGaps], sold: catalogue.summary.sold },
    social: socialSummary,
    providerBlockers: { ebay: getEbayAnalyticsReadiness(db, env, now).blockers, instagram: socialReadiness.instagram.blockers, pinterest: socialReadiness.pinterest.blockers },
    researchProviderConfigured: getConfiguredResearchProvider(env) !== null,
    experiments,
    findings: knowledge.findings.map((f: any) => ({ id: f.id, topicDomain: f.topicDomain, topic: f.topic, claim: f.claim, classification: f.classification, sourceQuality: f.sourceQuality, sourceDomain: f.sourceDomain, freshness: f.freshness, category: f.category, platform: f.platform, businessRelevance: f.businessRelevance })),
    openConflicts: knowledge.conflicts.filter((c: any) => c.state === "OPEN").map((c: any) => ({ id: c.id, findingAId: c.findingAId, findingBId: c.findingBId })),
  };
}

export function getRoadmap(db: DbClient, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env) {
  return buildRoadmap(gatherInputs(db, now, env));
}

/** Evidence inventory by tier (what the roadmap is built from) - counts and readiness only. */
export function getIntelligenceView(db: DbClient, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env) {
  const inputs = gatherInputs(db, now, env);
  const byQuality = (q: string) => inputs.findings.filter((f) => f.sourceQuality === q && f.freshness !== "STALE" && f.freshness !== "SUPERSEDED").length;
  return {
    generatedAt: now.toISOString(),
    evidencePriority: Object.entries(EVIDENCE_TIERS).map(([tier, rank]) => ({ rank, tier })),
    evidence: {
      NOCTELLA_TRANSACTION: { soldProducts: inputs.catalogue.sold, byProfitStatus: inputs.catalogue.byProfitStatus, policyGaps: inputs.catalogue.policyGaps },
      PLATFORM_ANALYTICS: { socialEntities: inputs.social.entities, mapped: inputs.social.mapped, unmapped: inputs.social.unmapped, providerBlockers: inputs.providerBlockers },
      NOCTELLA_EXPERIMENT: { total: inputs.experiments.length, decided: inputs.experiments.filter((e) => e.result).length, currentBestPractices: inputs.experiments.filter((e) => e.result?.bestPractice === "CURRENT").length },
      AUTHORITATIVE_EXTERNAL: { findings: byQuality("A") },
      MULTI_SOURCE_MARKET: { findings: byQuality("B") },
      COMMUNITY_SIGNAL: { findings: byQuality("C") },
      SINGLE_WEAK_OPINION: { findings: byQuality("D") },
    },
    openConflicts: inputs.openConflicts.length,
    researchProviderConfigured: inputs.researchProviderConfigured,
    advisoryOnly: true,
  };
}
