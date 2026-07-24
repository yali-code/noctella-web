import { Router } from "express";
import { requirePermission } from "../auth/permissions";

/**
 * Placeholder router for "settings". Sprint 1 scope only — no business logic,
 * ERP sync, AI generation, or persistence implemented yet.
 */
const router = Router();
router.use(requirePermission("settings.manage"));

router.get("/", (_req, res) => {
  res.json({ module: "settings", status: "not_implemented" });
});

export default router;
