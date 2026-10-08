import path from "node:path";
import { Router, type Response } from "express";
import { z } from "zod";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import { createMediaPlanRepository } from "../repositories/media-planning/sqlite";
import {
  approveMediaPlan, editMediaPlanItem, generateMediaPlan, getLatestMediaPlan, getMediaPlan, getMediaPlannerReadiness, mediaAssetDir,
  MediaPlanningBlockedError, rejectMediaPlan, renderPlanReel, scheduleMediaPlan,
} from "../services/mediaPlanner";
import { handleRouteError } from "./errorHandler";

/**
 * Media Planning Agent API (admin session). Reads need products.view; generating/editing needs
 * products.edit; approve/reject/schedule need products.publish (the same permission that gates
 * existing social approvals). No endpoint publishes - scheduling hands off to the Social Agent chain.
 */
const fail = (error: unknown, res: Response) => {
  if (error instanceof MediaPlanningBlockedError) { res.status(409).json({ error: "MEDIA_PLANNING_BLOCKED", blockers: error.blockers }); return; }
  handleRouteError(error, res);
};
const generateSchema = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();

export function createMediaPlannerRouter() {
  const router = Router();
  router.get("/readiness", requirePermission("products.view"), async (_req, res) => { try { res.json(await getMediaPlannerReadiness(db)); } catch (e) { fail(e, res); } });
  router.get("/plans/latest", requirePermission("products.view"), (_req, res) => { try { res.json({ plan: getLatestMediaPlan(db) }); } catch (e) { fail(e, res); } });
  router.get("/plans/:id", requirePermission("products.view"), (req, res) => { try { res.json(getMediaPlan(db, req.params.id)); } catch (e) { fail(e, res); } });
  router.post("/plans", requirePermission("products.edit"), async (req: AuthedRequest, res) => {
    try { res.status(201).json(await generateMediaPlan(db, { generatedBy: req.adminUser!.id, ...generateSchema.parse(req.body ?? {}) })); } catch (e) { fail(e, res); }
  });
  router.patch("/plans/:id/items/:itemId", requirePermission("products.edit"), (req, res) => { try { res.json(editMediaPlanItem(db, req.params.id, req.params.itemId, req.body)); } catch (e) { fail(e, res); } });
  router.post("/plans/:id/items/:itemId/render-reel", requirePermission("products.edit"), async (req, res) => { try { res.json(await renderPlanReel(db, req.params.id, req.params.itemId)); } catch (e) { fail(e, res); } });
  router.post("/plans/:id/approve", requirePermission("products.publish"), (req: AuthedRequest, res) => { try { res.json(approveMediaPlan(db, req.params.id, req.adminUser!.id)); } catch (e) { fail(e, res); } });
  router.post("/plans/:id/reject", requirePermission("products.publish"), (req, res) => { try { res.json(rejectMediaPlan(db, req.params.id)); } catch (e) { fail(e, res); } });
  router.post("/plans/:id/schedule", requirePermission("products.publish"), async (req: AuthedRequest, res) => { try { res.json(await scheduleMediaPlan(db, req.params.id, req.adminUser!.id)); } catch (e) { fail(e, res); } });
  router.get("/plans/:id/items/:itemId/reel", requirePermission("products.view"), (req, res) => {
    const item = createMediaPlanRepository(db).getItem(req.params.id, req.params.itemId);
    const root = path.resolve(mediaAssetDir());
    const file = item?.reelAssetPath ? path.resolve(item.reelAssetPath) : null;
    if (!item || item.reelAssetStatus !== "RENDERED" || !file || !file.startsWith(root + path.sep)) { res.status(404).json({ error: "Reel asset not available" }); return; }
    res.type("video/mp4").sendFile(file);
  });
  return router;
}
