// @vitest-environment node
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "scheduler-token-intel";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import {
  createExperiment, finalizeExperiment, getIntelligenceView, getKnowledgeView, getRoadmap, ingestResearchFindings, listExperimentsView,
  recordExperimentObservation, ResearchProviderNotConfiguredError, runWebResearch, startExperiment, stopExperiment,
} from "../src/services/analyticsIntelligence";
import { evidenceStrength } from "../src/use-cases/analytics/intelligenceRoadmap";
import { classifySourceQuality, freshness, researchPeriodKey } from "../src/use-cases/analytics/knowledge";

/**
 * Analytics Stage 3 PR-2: experiment registry, Knowledge Memory, research seam, evidence fusion and
 * the advisory roadmap. No provider or LLM is called; nothing operational is mutated.
 */

const T0 = new Date("2026-09-01T00:00:00.000Z");
const T_END = new Date("2026-09-20T00:00:00.000Z");

function memoryDb() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema }) as any;
  db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Compact camera", slug: "compact-camera", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).run();
  return { sqlite, db };
}

const experimentInput = (variants = 2, overrides: Record<string, unknown> = {}) => ({
  title: "Reel hook styles for compact cameras",
  hypothesis: "A close-up opening shot increases saves for compact digital cameras.",
  domain: "social_content",
  platform: "instagram",
  evidenceStyle: "exact_ab",
  primaryMetric: "instagram.media_saves",
  primaryMetricDirection: "increase",
  guardrails: [{ metric: "profitability.margin_percent", operator: "min", threshold: 20 }],
  minDurationDays: 14,
  minObservationsPerVariant: 2,
  variants: Array.from({ length: variants }, (_, i) => ({ key: "ABCDEF"[i], description: `Variant ${"ABCDEF"[i]}`, isControl: i === 0 })),
  ...overrides,
});

function observe(db: any, id: string, rows: Array<[string, string, number, number]>) {
  rows.forEach(([variantKey, metricKey, value, sampleSize], i) =>
    recordExperimentObservation(db, id, { observationKey: `obs-${variantKey}-${metricKey}-${i}`, variantKey, metricKey, value, sampleSize, observedAt: "2026-09-10T00:00:00.000Z", sourceReference: "analytics_metric_snapshots" }));
}

describe("Experiment registry", () => {
  it("accepts 2-5 variants and rejects more than 5 (and a missing/duplicate control)", () => {
    const { db } = memoryDb();
    for (const n of [2, 3, 4, 5]) expect(createExperiment(db, experimentInput(n), T0).variants).toHaveLength(n);
    expect(() => createExperiment(db, experimentInput(6), T0)).toThrow();
    expect(() => createExperiment(db, experimentInput(1), T0)).toThrow();
    expect(() => createExperiment(db, { ...experimentInput(2), variants: [{ key: "A", description: "a" }, { key: "B", description: "b" }] }, T0)).toThrow(/control/);
  });

  it("fixes the success metric: observations for undeclared metrics are rejected (no post-hoc winners)", () => {
    const { db } = memoryDb();
    const exp = createExperiment(db, experimentInput(), T0);
    startExperiment(db, exp.id, T0);
    expect(() => recordExperimentObservation(db, exp.id, { observationKey: "x", variantKey: "A", metricKey: "instagram.media_views", value: 1, sampleSize: 1, observedAt: T0.toISOString(), sourceReference: "s" })).toThrow(/primary metric/);
    expect(listExperimentsView(db, T0).experiments[0]!.primaryMetric).toBe("instagram.media_saves");
    // idempotent observation key
    observe(db, exp.id, [["A", "instagram.media_saves", 4, 10]]);
    expect(recordExperimentObservation(db, exp.id, { observationKey: "obs-A-instagram.media_saves-0", variantKey: "A", metricKey: "instagram.media_saves", value: 4, sampleSize: 10, observedAt: "2026-09-10T00:00:00.000Z", sourceReference: "analytics_metric_snapshots" })).toEqual({ recorded: false, replayed: true });
  });

  it("weak evidence finalizes as INCONCLUSIVE; finalization is idempotent", () => {
    const { db } = memoryDb();
    const exp = createExperiment(db, experimentInput(), T0);
    startExperiment(db, exp.id, T0);
    expect(() => finalizeExperiment(db, exp.id, new Date("2026-09-05T00:00:00.000Z"))).toThrow(/duration/);
    observe(db, exp.id, [["A", "instagram.media_saves", 4, 10]]); // B has no observations
    const done = finalizeExperiment(db, exp.id, T_END);
    expect(done.result).toMatchObject({ resultState: "INCONCLUSIVE", winningVariant: null, confidenceLevel: "INSUFFICIENT" });
    expect(finalizeExperiment(db, exp.id, new Date("2026-09-21T00:00:00.000Z"))).toMatchObject({ replayed: true, result: { resultState: "INCONCLUSIVE" } });
  });

  it("a clear winner that passes guardrails is preserved as current best practice; a guardrail breach is REJECTED", () => {
    const { db } = memoryDb();
    const exp = createExperiment(db, experimentInput(), T0);
    startExperiment(db, exp.id, T0);
    observe(db, exp.id, [["A", "instagram.media_saves", 4, 10], ["A", "instagram.media_saves", 5, 10], ["B", "instagram.media_saves", 8, 10], ["B", "instagram.media_saves", 9, 10], ["B", "profitability.margin_percent", 35, 1]]);
    const done = finalizeExperiment(db, exp.id, T_END);
    expect(done.result).toMatchObject({ resultState: "WINNER", winningVariant: "B", confidenceLevel: "MEDIUM", bestPractice: "CURRENT" });
    expect(listExperimentsView(db, T_END).currentBestPractices).toEqual([expect.objectContaining({ experimentId: exp.id, winningVariant: "B", status: "CURRENT" })]);
    expect(listExperimentsView(db, new Date("2027-01-01T00:00:00.000Z")).currentBestPractices[0]!.status).toBe("REVALIDATION_DUE");

    const breach = createExperiment(db, experimentInput(), T0);
    startExperiment(db, breach.id, T0);
    observe(db, breach.id, [["A", "instagram.media_saves", 4, 10], ["A", "instagram.media_saves", 4, 10], ["B", "instagram.media_saves", 9, 10], ["B", "instagram.media_saves", 9, 10], ["B", "profitability.margin_percent", 5, 1]]);
    expect(finalizeExperiment(db, breach.id, T_END).result).toMatchObject({ resultState: "REJECTED", winningVariant: null });
  });

  it("non-randomized evidence styles never claim more than their confidence cap", () => {
    const { db } = memoryDb();
    const exp = createExperiment(db, experimentInput(2, { evidenceStyle: "before_after", guardrails: [] }), T0);
    startExperiment(db, exp.id, T0);
    observe(db, exp.id, [["A", "instagram.media_saves", 2, 50], ["A", "instagram.media_saves", 2, 50], ["A", "instagram.media_saves", 2, 50], ["A", "instagram.media_saves", 2, 50], ["B", "instagram.media_saves", 9, 50], ["B", "instagram.media_saves", 9, 50], ["B", "instagram.media_saves", 9, 50], ["B", "instagram.media_saves", 9, 50]]);
    expect(finalizeExperiment(db, exp.id, T_END).result).toMatchObject({ resultState: "WINNER", confidenceLevel: "LOW" });
  });

  it("a stopped experiment remains retrievable with its STOPPED result", () => {
    const { db } = memoryDb();
    const exp = createExperiment(db, experimentInput(), T0);
    startExperiment(db, exp.id, T0);
    stopExperiment(db, exp.id, T_END, "brand concerns");
    const view = listExperimentsView(db, T_END).experiments.find((e: any) => e.id === exp.id);
    expect(view).toMatchObject({ status: "stopped", result: { resultState: "STOPPED", evidenceSummary: { reason: "brand concerns" } } });
  });
});

const NOW = new Date("2026-10-08T00:00:00.000Z");
const finding = (overrides: Record<string, unknown> = {}) => ({
  topicDomain: "CATEGORY", topic: "early CCD compact cameras", claim: "Demand for early CCD compact cameras is rising among collectors.", classification: "TREND_SIGNAL",
  sourceUrl: "https://www.ebay.com/news/collectibles-trends", sourceType: "official_announcement", publishedAt: "2026-09-20T00:00:00.000Z", category: "Cameras", ...overrides,
});

describe("Knowledge Memory", () => {
  it("retains provenance, classifies source quality deterministically and redacts personal identifiers", () => {
    const { db } = memoryDb();
    const result = ingestResearchFindings(db, { provider: "manual", now: NOW, candidates: [finding({ excerpt: "As u/collector42 (mail me@example.com) and @camfan said, prices rose." })] });
    expect(result).toMatchObject({ newFindings: 1, rejected: [] });
    const [f] = getKnowledgeView(db, {}, NOW).findings;
    expect(f).toMatchObject({ sourceUrl: "https://www.ebay.com/news/collectibles-trends", sourceDomain: "ebay.com", sourceType: "official_announcement", sourceQuality: "A", publishedAt: "2026-09-20T00:00:00.000Z", collectedAt: NOW.toISOString(), firstRunId: result.run.id, freshness: "CURRENT", requiresNoctellaVerification: true, status: "ACTIVE" });
    expect(f.evidenceExcerpt).toBe("As [user] (mail [email]) and [handle] said, prices rose.");
    expect(classifySourceQuality("https://community.ebay.com/t5/x", "other")).toBe("C");
    expect(classifySourceQuality("https://blog.unknown.example/x", "specialist_publication")).toBe("D");
  });

  it("community sentiment is never stored as FACT", () => {
    const { db } = memoryDb();
    ingestResearchFindings(db, { provider: "manual", now: NOW, candidates: [finding({ classification: "FACT", sourceUrl: "https://www.reddit.com/r/vintagecameras/comments/1", sourceType: "community", claim: "Everyone says CCD cameras sell instantly on eBay." })] });
    expect(getKnowledgeView(db, {}, NOW).findings[0]).toMatchObject({ classification: "COMMUNITY_SENTIMENT", sourceQuality: "C", confidence: "LOW" });
  });

  it("superseded and stale findings stay retrievable; conflicts are stored, not overwritten; duplicate runs are idempotent", () => {
    const { db } = memoryDb();
    const first = ingestResearchFindings(db, { provider: "manual", periodKey: "2026-09-H2", now: NOW, candidates: [finding(), finding({ topicDomain: "MARKETPLACE", topic: "eBay fees", claim: "eBay final value fee for collectibles is 12.9 percent.", classification: "FACT", sourceUrl: "https://www.ebay.com/help/fees", publishedAt: "2025-01-01T00:00:00.000Z" })] });
    const [trend, fee] = [getKnowledgeView(db, {}, NOW).findings.find((f: any) => f.topicDomain === "CATEGORY"), getKnowledgeView(db, {}, NOW).findings.find((f: any) => f.topicDomain === "MARKETPLACE")];
    expect(fee.freshness).toBe("STALE");

    const second = ingestResearchFindings(db, { provider: "manual", periodKey: "2026-10-H1", now: NOW, candidates: [
      finding({ claim: "Demand for early CCD cameras has plateaued since September.", relation: { type: "conflicts", findingId: trend.id } }),
      finding({ topicDomain: "MARKETPLACE", topic: "eBay fees", claim: "eBay final value fee for collectibles is 13.25 percent.", classification: "FACT", sourceUrl: "https://www.ebay.com/help/fees-2026", publishedAt: "2026-10-01T00:00:00.000Z", relation: { type: "supersedes", findingId: fee.id } }),
      finding(), // already known -> confirmation, not a duplicate
    ] });
    expect(second).toMatchObject({ newFindings: 2, confirmedFindings: 1, superseded: 1, conflicts: 1 });
    const view = getKnowledgeView(db, {}, NOW);
    expect(view.findings).toHaveLength(4);
    expect(view.findings.find((f: any) => f.id === fee.id)).toMatchObject({ status: "SUPERSEDED", freshness: "SUPERSEDED" });
    expect(view.findings.find((f: any) => f.id === trend.id)).toMatchObject({ status: "ACTIVE", lastConfirmedRunId: second.run.id, firstRunId: first.run.id });
    expect(view.conflicts).toEqual([expect.objectContaining({ state: "OPEN" })]);

    expect(ingestResearchFindings(db, { provider: "manual", periodKey: "2026-10-H1", now: NOW, candidates: [finding({ claim: "Something new and different entirely here." })] })).toMatchObject({ replayed: true, newFindings: 0 });
    expect(getKnowledgeView(db, {}, NOW).findings).toHaveLength(4);
    expect(freshness({ status: "ACTIVE", publishedAt: null, reviewBy: NOW.toISOString() }, NOW)).toBe("UNKNOWN");
  });

  it("research seam: twice-monthly periods, fails closed without a provider, ingests through an injected provider idempotently", async () => {
    expect([researchPeriodKey(new Date("2026-10-15T23:00:00.000Z")), researchPeriodKey(new Date("2026-10-16T00:00:00.000Z"))]).toEqual(["2026-10-H1", "2026-10-H2"]);
    const { db } = memoryDb();
    await expect(runWebResearch(db, null, NOW)).rejects.toBeInstanceOf(ResearchProviderNotConfiguredError);
    let calls = 0;
    const provider = { name: "fake-search", research: async (plan: any) => { calls += 1; expect(plan.topics.length).toBeGreaterThan(20); return [finding()]; } };
    expect(await runWebResearch(db, provider, NOW)).toMatchObject({ newFindings: 1 });
    expect(await runWebResearch(db, provider, new Date("2026-10-09T00:00:00.000Z"))).toMatchObject({ replayed: true });
    expect(calls).toBe(1);
  });
});

describe("Evidence fusion + roadmap", () => {
  it("evidence strength: verified internal data outranks weak opinion; a data gap lowers strength", () => {
    expect(evidenceStrength(["NOCTELLA_TRANSACTION"])).toBe("MODERATE");
    expect(evidenceStrength(["NOCTELLA_TRANSACTION", "NOCTELLA_EXPERIMENT"])).toBe("STRONG");
    expect(evidenceStrength(["AUTHORITATIVE_EXTERNAL"])).toBe("WEAK");
    expect(evidenceStrength(["COMMUNITY_SIGNAL", "SINGLE_WEAK_OPINION"])).toBe("INSUFFICIENT");
    expect(evidenceStrength(["NOCTELLA_TRANSACTION"], { dataGap: true })).toBe("WEAK");
    expect(evidenceStrength([])).toBe("INSUFFICIENT");
  });

  it("builds TODAY/THIS_WEEK/THIS_MONTH/WATCHLIST/RISKS: external ideas -> TEST_NEXT/WATCH, Noctella winners -> PROVEN_ACTION, data gaps surfaced, advisory only, no mutation", () => {
    const { sqlite, db } = memoryDb();
    ingestResearchFindings(db, { provider: "manual", now: NOW, candidates: [
      finding(),
      finding({ topic: "CCD hype", claim: "Collectors on forums say CCD cameras are the next big thing.", classification: "COMMUNITY_SENTIMENT", sourceUrl: "https://www.reddit.com/r/cameras/1", sourceType: "community" }),
    ] });
    const exp = createExperiment(db, experimentInput(), T0);
    startExperiment(db, exp.id, T0);
    observe(db, exp.id, [["A", "instagram.media_saves", 4, 10], ["A", "instagram.media_saves", 5, 10], ["B", "instagram.media_saves", 8, 10], ["B", "instagram.media_saves", 9, 10], ["B", "profitability.margin_percent", 35, 1]]);
    finalizeExperiment(db, exp.id, T_END);

    const tables = ["products", "external_listings", "social_contents", "instagram_publish_attempts", "marketplace_connections", "analytics_metric_snapshots", "sale_financials"];
    const dump = () => tables.map((t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = dump();
    const roadmap = getRoadmap(db, new Date("2026-09-21T00:00:00.000Z"), {});
    getIntelligenceView(db, new Date("2026-09-21T00:00:00.000Z"), {});
    expect(dump()).toEqual(before);

    expect(Object.keys(roadmap.horizons)).toEqual(["TODAY", "THIS_WEEK", "THIS_MONTH", "WATCHLIST", "RISKS"]);
    const all = Object.values(roadmap.horizons).flat();
    expect(all.every((i) => i.advisoryOnly === true && i.executionRoute.approval === "OWNER_APPROVAL_REQUIRED")).toBe(true);

    const dataGap = roadmap.horizons.TODAY.find((i) => i.key === "DATA_GAP:profitability")!;
    expect(dataGap).toMatchObject({ type: "DATA_GAP", blockers: ["PAYMENT_FEE_POLICY_INCOMPLETE"] });
    expect(roadmap.marginRecommendationsSuppressed).toBe(true);

    const proven = roadmap.horizons.THIS_WEEK.find((i) => i.type === "PROVEN_ACTION")!;
    expect(proven).toMatchObject({ key: `PROVEN_ACTION:experiment:${exp.id}`, evidenceStrength: "MODERATE", executionRoute: { department: "MEDIA" } });

    const trend = all.find((i) => i.title === "Test: early CCD compact cameras")!;
    expect(trend).toMatchObject({ type: "TEST_NEXT", horizon: "THIS_MONTH", evidenceStrength: "WEAK" });
    const sentiment = all.find((i) => i.title === "Watch: CCD hype")!;
    expect(sentiment).toMatchObject({ type: "WATCH", horizon: "WATCHLIST", evidenceStrength: "INSUFFICIENT" });
    expect(all.filter((i) => i.type === "PROVEN_ACTION").every((i) => i.evidence.some((e) => e.tier === "NOCTELLA_EXPERIMENT"))).toBe(true);

    expect(roadmap.horizons.RISKS.map((i) => i.key)).toEqual(expect.arrayContaining(["RISK:research_provider", "RISK:provider:ebay", "RISK:provider:instagram", "RISK:provider:pinterest"]));
  });

  it("routes: reads require a session; the research trigger requires the scheduler token and fails closed without a provider", async () => {
    const app = (await import("../src/app")).default;
    for (const path of ["roadmap", "intelligence", "experiments", "knowledge"]) expect((await request(app).get(`/api/analytics/${path}`)).status).toBe(401);
    expect((await request(app).post("/api/analytics/experiments").send(experimentInput())).status).toBe(401);
    expect((await request(app).post("/api/background-jobs/analytics-research")).status).toBe(401);
    const res = await request(app).post("/api/background-jobs/analytics-research").set("Authorization", "Bearer scheduler-token-intel");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "WEB_SEARCH_PROVIDER_ACTIVATION_REQUIRED" });
  }, 60_000);
});
