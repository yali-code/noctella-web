import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { getCatalogueProfitability } from "../services/productProfitability";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
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

export default router;
