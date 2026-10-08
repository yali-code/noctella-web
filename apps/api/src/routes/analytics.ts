import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { getProductAnalyticsHistory } from "../services/analyticsSnapshots";
import { getEbayAnalyticsReadiness } from "../services/ebayAnalytics";
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

export default router;
