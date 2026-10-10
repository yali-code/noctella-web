import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { z } from "zod";
import { db } from "../db/client";
import { getProductAnalyticsHistory } from "../services/analyticsSnapshots";
import { getEbayAnalyticsReadiness } from "../services/ebayAnalytics";
import { createExperiment, finalizeExperiment, getIntelligenceView, getKnowledgeView, getRoadmap, ingestResearchFindings, listExperimentsView, recordExperimentObservation, startExperiment, stopExperiment } from "../services/analyticsIntelligence";
import { completePinterestConnect, getSocialAnalyticsReadiness, getSocialMetricHistory, getSocialPerformance, startPinterestConnect } from "../services/socialAnalytics";
import { socialHistoryQuerySchema, socialPerformanceQuerySchema } from "../use-cases/analytics/socialPerformance";
import { PinterestOAuthError } from "../integrations/pinterest/pinterestOAuth";
import { getCatalogueProfitability } from "../services/productProfitability";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
import { productMetricHistoryQuerySchema } from "../use-cases/analytics/profitabilitySnapshots";
import { handleRouteError } from "./errorHandler";
import { readAdsCampaignReviewFromErp } from "../use-cases/ads/adsCampaignErpReader";
import { readAdsDraftPlanForProduct } from "../use-cases/ads/adsDraftPlan";
import { readCampaignDraftPreview } from "../use-cases/ads/adsCampaignDrafts";
import { readPaidAdsDryRunFromErp } from "../use-cases/ads/paidLaunchDryRun";
import { inspectPaidAdsProviderReadiness } from "../use-cases/ads/paidAdsReadiness";
import { readPaidCampaignReport } from "../use-cases/ads/adsPaidCampaignRead";

/**
 * Analytics router (analytics.view). GET / remains the original module placeholder.
 * Phase 1D: GET /profitability is a read-only catalogue profitability + insight view - the route
 * only validates the query and delegates; no mutation endpoint exists here.
 */
const router = Router();
router.use(requirePermission("analytics.view"));

router.get("/", (_req, res) => {
  res.json({ module: "analytics", status: "not_implemented" });
});

router.get("/profitability", (req, res) => {
  try {
    res.json(getCatalogueProfitability(db, catalogueProfitabilityQuerySchema.parse(req.query)));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// Phase 1G: read-only stored metric history for one product (snapshots written by the scheduler-
// triggered POST /api/background-jobs/analytics-snapshot, never by this router).
router.get("/profitability/:productId/history", (req, res) => {
  try {
    res.json(getProductAnalyticsHistory(db, req.params.productId, productMetricHistoryQuerySchema.parse(req.query)));
  } catch (error) {
    handleRouteError(error, res);
  }
});


// ADS-006C: exact-scope, paid-only Analytics snapshots, never organic metrics
// or inferred marketplace conversions. The router has analytics.view gate.
router.get("/ads/performance/:provider/:campaignId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const provider = z.enum(["meta", "google_ads", "pinterest_ads"]).parse(req.params.provider);
    const campaignId = z.string().regex(/^[0-9]{5,25}$/).parse(req.params.campaignId);
    res.json(await readPaidCampaignReport(db, provider, campaignId));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ADS-005A: configuration presence is not connection verification or permission to spend.
router.get("/ads/providers/readiness", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ providers: inspectPaidAdsProviderReadiness(), campaignsEnabled: false, spendAuthorized: false });
});

// ADS-005B: isolated dry-run only; no client-submitted verification flags.
router.get("/ads/launch-preflight/:productId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const productId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(req.params.productId);
    const policy = z.object({
      provider: z.enum(["meta", "google_ads", "pinterest_ads"]),
      requestedDailyEur: z.coerce.number().finite().positive().max(1_000_000),
      hardDailyLimitEur: z.coerce.number().finite().positive().max(1_000_000),
      hardTotalLimitEur: z.coerce.number().finite().positive().max(1_000_000),
    }).strict().parse(req.query);
    res.json(await readPaidAdsDryRunFromErp(db, productId, policy.provider, policy));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ADS-004C: advisory planning only; values supplied are a bounded hypothetical
// budget, never saved or used as spending authority.
const adsPlanEur = z.coerce.number().finite().positive().max(1000000).refine(x => Number.isInteger(Math.round(x * 100)) && Math.abs(x * 100 - Math.round(x * 100)) < 0.0000001, "Whole EUR cents required");
const adsPlanQuery = z.object({
  requestedDailyEur: adsPlanEur,
  hardDailyLimitEur: adsPlanEur,
  hardTotalLimitEur: adsPlanEur,
}).strict();
router.get("/ads/draft-plan/:productId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const productId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(req.params.productId);
    const budget = adsPlanQuery.parse(req.query);
    res.json(await readAdsDraftPlanForProduct(db, productId, budget));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ADS-008: read-only provider campaign draft preview (validation + fingerprint); never executes.
router.get("/ads/campaign-draft/:productId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const productId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(req.params.productId);
    const { provider, ...budget } = adsPlanQuery.extend({ provider: z.enum(["meta", "google_ads", "pinterest_ads"]) }).strict().parse(req.query);
    res.json(await readCampaignDraftPreview(db, productId, provider, budget));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ADS phase 3: authenticated, read-only review projection. Never triggers ad spend,
// an external provider call, a stock mutation, or a background sync.
// analytics.view is applied to this entire router above.
router.get("/ads/candidates/:productId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const productId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(req.params.productId);
    const result = await readAdsCampaignReviewFromErp(db, productId);
    res.json({ ...result, scope: "REVIEW_ONLY", liveProviderVerified: false, spendAuthorized: false });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// Stage 3B: sanitized eBay Analytics readiness (booleans/status only - never token values).
router.get("/ebay/readiness", (_req, res) => {
  try {
    res.json(getEbayAnalyticsReadiness(db));
  } catch (error) {
    handleRouteError(error, res);
  }
});

// Stage 3 social analytics: read-only performance/history/readiness (analytics.view).
router.get("/social", (req, res) => {
  try { res.json(getSocialPerformance(db, socialPerformanceQuerySchema.parse(req.query))); } catch (error) { handleRouteError(error, res); }
});
router.get("/social/history", (req, res) => {
  try { res.json(getSocialMetricHistory(db, socialHistoryQuerySchema.parse(req.query))); } catch (error) { handleRouteError(error, res); }
});
router.get("/social/readiness", (_req, res) => {
  try { res.json(getSocialAnalyticsReadiness(db)); } catch (error) { handleRouteError(error, res); }
});

// Pinterest consent (marketplace.manage): start returns the consent URL; the callback verifies the
// signed state before exchanging the code and returns sanitized readiness only (never tokens).
router.get("/social/pinterest/connect", requirePermission("marketplace.manage"), (_req, res) => {
  try { res.json(startPinterestConnect()); } catch (error) {
    if (error instanceof PinterestOAuthError) { res.status(409).json({ error: error.kind }); return; }
    handleRouteError(error, res);
  }
});
const pinterestCallbackSchema = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(4096) }).passthrough();
router.get("/social/pinterest/callback", requirePermission("marketplace.manage"), async (req, res) => {
  try {
    const { code, state } = pinterestCallbackSchema.parse(req.query);
    res.json(await completePinterestConnect(db, code, state));
  } catch (error) {
    if (error instanceof PinterestOAuthError) { res.status(error.kind === "not_configured" ? 409 : 400).json({ error: error.kind }); return; }
    handleRouteError(error, res);
  }
});

// Stage 3 PR-2: advisory intelligence. Reads need analytics.view; registry/research writes are
// owner-level (settings.manage). Nothing here executes business changes.
const knowledgeQuerySchema = z.object({ topicDomain: z.string().max(20).optional(), classification: z.string().max(30).optional(), status: z.string().max(20).optional() }).strict();
router.get("/experiments", (_req, res) => { try { res.json(listExperimentsView(db)); } catch (error) { handleRouteError(error, res); } });
router.get("/knowledge", (req, res) => { try { res.json(getKnowledgeView(db, knowledgeQuerySchema.parse(req.query))); } catch (error) { handleRouteError(error, res); } });
router.get("/intelligence", (_req, res) => { try { res.json(getIntelligenceView(db)); } catch (error) { handleRouteError(error, res); } });
router.get("/roadmap", (_req, res) => { try { res.json(getRoadmap(db)); } catch (error) { handleRouteError(error, res); } });
router.post("/experiments", requirePermission("settings.manage"), (req, res) => { try { res.status(201).json(createExperiment(db, req.body)); } catch (error) { handleRouteError(error, res); } });
router.post("/experiments/:id/start", requirePermission("settings.manage"), (req, res) => { try { res.json(startExperiment(db, req.params.id)); } catch (error) { handleRouteError(error, res); } });
router.post("/experiments/:id/observations", requirePermission("settings.manage"), (req, res) => { try { res.json(recordExperimentObservation(db, req.params.id, req.body)); } catch (error) { handleRouteError(error, res); } });
router.post("/experiments/:id/finalize", requirePermission("settings.manage"), (req, res) => { try { res.json(finalizeExperiment(db, req.params.id)); } catch (error) { handleRouteError(error, res); } });
router.post("/experiments/:id/stop", requirePermission("settings.manage"), (req, res) => { try { res.json(stopExperiment(db, req.params.id)); } catch (error) { handleRouteError(error, res); } });
const ingestSchema = z.object({ provider: z.string().regex(/^[a-z0-9_.-]{2,40}$/), periodKey: z.string().regex(/^\d{4}-\d{2}-H[12]$/).optional(), candidates: z.array(z.unknown()).min(1).max(500) }).strict();
router.post("/knowledge/ingest", requirePermission("settings.manage"), (req, res) => { try { const body = ingestSchema.parse(req.body); res.json(ingestResearchFindings(db, { provider: body.provider, periodKey: body.periodKey, candidates: body.candidates })); } catch (error) { handleRouteError(error, res); } });

export default router;
