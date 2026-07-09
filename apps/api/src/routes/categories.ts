import { Router } from "express";

/**
 * Placeholder router for "categories". Sprint 1 scope only — no business logic,
 * ERP sync, AI generation, or persistence implemented yet.
 */
const router = Router();

router.get("/", (_req, res) => {
  res.json({ module: "categories", status: "not_implemented" });
});

export default router;
