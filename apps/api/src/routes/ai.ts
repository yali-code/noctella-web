import { Router } from "express";
import { requirePermission } from "../auth/permissions";

/**
 * Placeholder router for "ai". Sprint 1 scope only — no business logic,
 * ERP sync, AI generation, or persistence implemented yet.
 */
const router = Router();
router.use(requirePermission("ai_drafts.view"));

router.get("/", (_req, res) => {
  res.json({ module: "ai", status: "not_implemented" });
});

export default router;
