import { Router } from "express";
import type { DbClient } from "../db/client";
import { createRequireAuth, requirePermission } from "../auth/permissions";
import { requireAdminOriginForMutations } from "../auth/csrf";
import { createSocialContentService } from "../services/socialContent";
import { handleRouteError } from "./errorHandler";

export function createSocialContentRouter(db: DbClient) {
  const router = Router();
  const service = createSocialContentService(db);
  router.use(requireAdminOriginForMutations, createRequireAuth(db));
  router.get("/", requirePermission("products.view"), async (req, res) => {
    try { res.json(await service.list(req.query)); } catch (error) { handleRouteError(error, res); }
  });
  router.get("/:id", requirePermission("products.view"), async (req, res) => {
    try { res.json(await service.get(req.params.id)); } catch (error) { handleRouteError(error, res); }
  });
  router.post("/", requirePermission("products.edit"), async (req, res) => {
    try { res.status(201).json(await service.create(req.body)); } catch (error) { handleRouteError(error, res); }
  });
  router.patch("/:id", requirePermission("products.edit"), async (req, res) => {
    try { res.json(await service.edit(req.params.id, req.body)); } catch (error) { handleRouteError(error, res); }
  });
  router.post("/:id/status", requirePermission("products.edit"), (req, res, next) => {
    if (req.body?.status === "approved" || req.body?.status === "rejected") return requirePermission("products.publish")(req, res, next);
    next();
  }, async (req, res) => {
    try { res.json(await service.transition(req.params.id, req.body)); } catch (error) { handleRouteError(error, res); }
  });
  return router;
}
