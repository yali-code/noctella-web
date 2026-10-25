import { and, eq, isNotNull } from "drizzle-orm";
import { Router } from "express";
import type { DbClient } from "../db/client";
import { socialPreparedImages } from "../db/schema";
import { INSTAGRAM_DERIVATIVE_NAME, INSTAGRAM_DERIVATIVE_STATIC_PATH, instagramDerivativeRoot, readStoreFile, sha256 } from "../integrations/instagram/instagramDerivativeStore";

/**
 * PUBLIC (Instagram must fetch image_url; no auth secret in the URL), P5: serves only a protected-mode Instagram
 * derivative that is registered in social_prepared_images with a recorded output_sha256, by its generated name - never a
 * filesystem path, no directory listing - and only while the stored bytes still hash-match that record. The bytes that
 * were hashed are the bytes sent (no check-then-reopen). Anything else, including temporaries and job dirs, is 404.
 */
export function createInstagramDerivativeAssetRouter(db: DbClient, root: () => string = () => instagramDerivativeRoot()) {
  const router = Router();
  router.get(`${INSTAGRAM_DERIVATIVE_STATIC_PATH}/:name`, async (req, res) => {
    try {
      const name = req.params.name;
      if (!INSTAGRAM_DERIVATIVE_NAME.test(name)) { res.status(404).end(); return; }
      const [registered] = await (db as any).select().from(socialPreparedImages)
        .where(and(eq(socialPreparedImages.outputPath, `${INSTAGRAM_DERIVATIVE_STATIC_PATH}/${name}`), isNotNull(socialPreparedImages.outputSha256))).limit(1);
      if (!registered) { res.status(404).end(); return; }
      const bytes = await readStoreFile(root(), name);
      if (sha256(bytes) !== registered.outputSha256) { res.status(404).end(); return; }
      res.type("image/jpeg").set("Cache-Control", "public, max-age=3600").send(bytes);
    } catch { res.status(404).end(); }
  });
  // No other path (nested segments, job dirs, temporaries, listings) or method under the prefix exists: always 404.
  router.use(INSTAGRAM_DERIVATIVE_STATIC_PATH, (_req, res) => { res.status(404).end(); });
  return router;
}
