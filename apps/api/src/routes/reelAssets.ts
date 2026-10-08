import { and, eq } from "drizzle-orm";
import { Router } from "express";
import type { DbClient } from "../db/client";
import { socialPreparedImages } from "../db/schema";
import { REEL_PUBLIC_PATH, reelNameFromPublicPath } from "../config/mediaAssets";
import { INSTAGRAM_REEL_RECIPE, inspectPreparedReel } from "../services/socialContentPreparation";

/**
 * PUBLIC (Instagram must fetch video_url; no auth secret in the URL): serves only an approved Reel
 * asset that is registered in social_prepared_images, by its generated name - never a filesystem
 * path, no directory listing - and only while the file still matches the approved fingerprint.
 */
export function createReelAssetRouter(db: DbClient) {
  const router = Router();
  router.get(`${REEL_PUBLIC_PATH}/:name`, async (req, res) => {
    try {
      const publicPath = `${REEL_PUBLIC_PATH}/${req.params.name}`;
      if (!reelNameFromPublicPath(publicPath)) { res.status(404).end(); return; }
      const [registered] = await (db as any).select().from(socialPreparedImages)
        .where(and(eq(socialPreparedImages.outputPath, publicPath), eq(socialPreparedImages.recipeVersion, INSTAGRAM_REEL_RECIPE))).limit(1);
      const asset = registered ? await inspectPreparedReel(publicPath) : null;
      if (!registered || !asset || asset.sha256 !== registered.sourceFingerprint) { res.status(404).end(); return; }
      res.type("video/mp4").set("Cache-Control", "public, max-age=3600").sendFile(asset.file);
    } catch { res.status(404).end(); }
  });
  return router;
}
