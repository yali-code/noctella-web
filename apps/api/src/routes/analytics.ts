import { Router } from "express";
import { requirePermission } from "../auth/permissions";

/**
 * Placeholder router for "analytics". Sprint 1 scope only — no business logic,
 * ERP sync, AI generation, or persistence implemented yet.
 */
const router = Router();
router.use(requirePermission("analytics.view"));

router.get("/", (_req, res) => {
  res.json({ module: "analytics", status: "not_implemented" });
});

export default router;
