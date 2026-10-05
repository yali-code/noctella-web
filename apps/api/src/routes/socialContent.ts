import { Router } from "express";
import type { DbClient } from "../db/client";
import { createRequireAuth, requirePermission, type AuthedRequest } from "../auth/permissions";
import { requireAdminOriginForMutations } from "../auth/csrf";
import { createSocialContentService } from "../services/socialContent";
import { createSocialPublishIntentService } from "../services/socialPublishIntents";
import { createSocialContentPreparationService } from "../services/socialContentPreparation";
import { resolvePublicApiOrigin } from "../config/publicApiOrigin";
import { socialId, socialPrepareImageSchema } from "../validation/socialContent";
import { selectNextSocialContentCandidate } from "../services/socialContentSelection";
import { handleRouteError } from "./errorHandler";
import { generateSocialContent } from "../services/socialContentGeneration";
import { socialGenerationRequestSchema } from "../use-cases/social-content/useCases";
import { createSocialGenerationProvider, type SocialGenerationProvider } from "../social-content/provider";

export function createSocialContentRouter(db: DbClient, providerFactory: () => SocialGenerationProvider = createSocialGenerationProvider) {
  const router = Router();
  const service = createSocialContentService(db);
  router.use(requireAdminOriginForMutations, createRequireAuth(db));
  router.post("/publish-intents", requirePermission("products.publish"), async (req: AuthedRequest, res) => {
    try { res.status(201).json(await createSocialPublishIntentService(db).create(req.body, req.adminUser!.id)); }
    catch (error) { handleRouteError(error, res); }
  });
  router.post("/:id/prepare-image", requirePermission("products.edit"), async (req, res) => {
    try {
      const contentId = socialId.parse(req.params.id);
      const input = socialPrepareImageSchema.parse(req.body);
      const result = await createSocialContentPreparationService(db).prepare(contentId, input.photoId, resolvePublicApiOrigin(), input.recipe);
      const { id, sourcePhotoId, sourceFingerprint, recipeVersion, outputPath } = result;
      res.json({ id, contentId: result.contentId, sourcePhotoId, sourceFingerprint, recipeVersion, outputPath });
    } catch (error) { handleRouteError(error, res); }
  });
  router.post("/generate", requirePermission("products.edit"), async (req, res) => {
    try { res.status(201).json(await generateSocialContent(db, socialGenerationRequestSchema.parse(req.body), providerFactory)); }
    catch (error) { handleRouteError(error, res); }
  });
  router.get("/", requirePermission("products.view"), async (req, res) => {
    try { res.json(await service.list(req.query)); } catch (error) { handleRouteError(error, res); }
  });
  router.get("/next-candidate", requirePermission("products.edit"), async (_req, res) => {
    try { res.json(await selectNextSocialContentCandidate(db)); } catch (error) { handleRouteError(error, res); }
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
  router.post("/:id/approve", requirePermission("products.edit"), requirePermission("products.publish"), async (req: AuthedRequest, res) => {
    try { res.json(await service.approve(req.params.id, req.body, req.adminUser!.id)); }
    catch (error) { handleRouteError(error, res); }
  });
  router.post("/:id/status", requirePermission("products.edit"), (req, res, next) => {
    if (req.body?.status === "approved" || req.body?.status === "rejected") return requirePermission("products.publish")(req, res, next);
    next();
  }, async (req, res) => {
    try { res.json(await service.transition(req.params.id, req.body)); } catch (error) { handleRouteError(error, res); }
  });
  return router;
}
