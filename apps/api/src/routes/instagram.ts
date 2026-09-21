import { Router } from "express";
import type { DbClient } from "../db/client";
import { createRequireAuth, requirePermission } from "../auth/permissions";
import { requireAdminOriginForMutations } from "../auth/csrf";
import { getInstagramConnection, upsertInstagramConnection, verifyInstagramConnection } from "../integrations/instagram/connection";
import { InstagramClientError, type InstagramTransport } from "../integrations/instagram/types";
import { getInstagramPublishAttempt, publishInstagramImage } from "../services/instagramPublishing";

function reject(error: unknown, res: import("express").Response): void {
  if (!(error instanceof InstagramClientError)) { res.status(500).json({ error: "Instagram operation failed" }); return; }
  const status = error.kind === "authentication" ? 401 : error.kind === "authorization" ? 403 : error.kind === "not_found" ? 404 : error.kind === "rate_limit" ? 429 : error.kind === "timeout" || error.kind === "provider" || error.kind === "unknown" ? 503 : 400;
  res.status(status).json({ error: error.message, kind: error.kind, retryable: error.retryable });
}

/** Standalone auth makes the router safe even if accidentally mounted before the global Admin gate. */
export function createInstagramRouter(db: DbClient, transport?: InstagramTransport, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  router.use(requireAdminOriginForMutations);
  router.use(createRequireAuth(db));

  router.get("/connection", requirePermission("marketplace.view"), async (_req, res) => {
    try { res.json(await getInstagramConnection(db)); } catch (error) { reject(error, res); }
  });
  router.post("/connection", requirePermission("marketplace.manage"), async (req, res) => {
    try {
      const { accessToken, accountLabel, scopes, tokenExpiresAt } = req.body ?? {};
      if (typeof accessToken !== "string" || !accessToken || accessToken.length > 8192 || accessToken !== accessToken.trim() ||
          !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) throw new InstagramClientError("configuration", false);
      res.json(await upsertInstagramConnection(db, { accessToken, accountLabel, scopes, tokenExpiresAt }, transport, env));
    } catch (error) { reject(error, res); }
  });
  router.post("/connection/verify", requirePermission("marketplace.manage"), async (_req, res) => {
    try { res.json(await verifyInstagramConnection(db, transport, env)); } catch (error) { reject(error, res); }
  });
  router.post("/publish", requirePermission("products.publish"), async (req, res) => {
    try {
      const { accountLabel, imageUrl, caption, idempotencyKey } = req.body ?? {};
      if (typeof imageUrl !== "string" || typeof caption !== "string" || typeof idempotencyKey !== "string") throw new InstagramClientError("configuration", false);
      res.json(await publishInstagramImage(db, { accountLabel, imageUrl, caption, idempotencyKey }, transport, env));
    } catch (error) { reject(error, res); }
  });
  router.get("/attempts/:id", requirePermission("marketplace.view"), async (req, res) => {
    try {
      if (req.params.id.length > 40 || !/^igp_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))
        throw new InstagramClientError("configuration", false);
      const attempt = await getInstagramPublishAttempt(db, req.params.id);
      if (!attempt) throw new InstagramClientError("not_found", false);
      res.json(attempt);
    } catch (error) { reject(error, res); }
  });
  return router;
}
