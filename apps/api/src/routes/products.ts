import { Router } from "express";

/**
 * Placeholder router for "products". Sprint 1 scope only — no business logic,
 * ERP sync, AI generation, or persistence implemented yet.
 */
const router = Router();

router.get("/", (_req, res) => {
  res.json({ module: "products", status: "not_implemented" });
});

export default router;
