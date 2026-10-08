import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { z } from "zod";
import { db } from "../db/client";
import { getProductAnalyticsHistory } from "../services/analyticsSnapshots";
import { getEbayAnalyticsReadiness } from "../services/ebayAnalytics";
import { completePinterestConnect, getSocialAnalyticsReadiness, getSocialMetricHistory, getSocialPerformance, startPinterestConnect } from "../services/socialAnalytics";
import { socialHistoryQuerySchema, socialPerformanceQuerySchema } from "../use-cases/analytics/socialPerformance";
import { PinterestOAuthError } from "../integrations/pinterest/pinterestOAuth";
import { getCatalogueProfitability } from "../services/productProfitability";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
import { productMetricHistoryQuerySchema } from "../use-cases/analytics/profitabilitySnapshots";
import { handleRouteError } from "./errorHandler";

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

export default router;
