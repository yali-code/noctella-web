import type { DbClient } from "../db/client";
import { prepareInstagramImageAsset, inspectPreparedInstagramImage, INSTAGRAM_IMAGE_RECIPE, type InstagramImageRecipe } from "../integrations/instagram/mediaPreparation";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mediaAssetDir, REEL_PUBLIC_PATH, reelFilePath, reelNameFromPublicPath } from "../config/mediaAssets";
import { isMp4File } from "../integrations/media/reelRenderer";

/** Prepared-asset recipe for a rendered Reel MP4 (images keep their existing recipes unchanged). */
export const INSTAGRAM_REEL_RECIPE = "instagram-reel-v1";
/** Instagram's documented Reel upload ceiling is far higher; this guards the pilot's ~8 s assets. */
const MAX_REEL_BYTES = 100 * 1024 * 1024;

/** Current state of a published Reel path: exists, real MP4 signature, bounded size -> sha256; otherwise null (fail closed). */
export async function inspectPreparedReel(publicPath: string, env: NodeJS.ProcessEnv = process.env): Promise<{ file: string; sha256: string; bytes: number } | null> {
  const name = reelNameFromPublicPath(publicPath);
  const file = name ? reelFilePath(name, env) : null;
  if (!file) return null;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0 || info.size > MAX_REEL_BYTES || !(await isMp4File(file))) return null;
  return { file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"), bytes: info.size };
}

/** Internal image preparation only: no route, provider or publishing side effect. */
export function createSocialContentPreparationService(
  db: DbClient,
  driver = process.env.DATABASE_DRIVER ?? "sqlite",
  render: typeof prepareInstagramImageAsset = prepareInstagramImageAsset,
  inspect: typeof inspectPreparedInstagramImage = inspectPreparedInstagramImage,
) {
  const repository = createPreparedImageRepository(db, driver);
  return {
    async validatePreparedImageCurrent(contentId: string, preparedImageId: string) {
      const snapshot = () => repository.transaction(function* (tx) {
        const preparedImage = yield* repository.find(tx, contentId, preparedImageId);
        const source = yield* repository.source(tx, contentId, preparedImage.sourcePhotoId);
        return { preparedImage, source };
      });
      try {
        const before = await snapshot();
        const valid = before.preparedImage.recipeVersion === INSTAGRAM_REEL_RECIPE
          ? (await inspectPreparedReel(before.preparedImage.outputPath))?.sha256 === before.preparedImage.sourceFingerprint
          : await inspect({ url: before.source.url }, before.preparedImage);
        let current: Awaited<ReturnType<typeof snapshot>>;
        try { current = await snapshot(); }
        catch (error) {
          if (error instanceof BadRequestError || error instanceof NotFoundError) throw new ConflictError("Prepared image state changed during validation");
          throw error;
        }
        if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Prepared image state changed during validation");
        if (!valid) throw new BadRequestError("Prepared image is not current");
        return { preparedImage: current.preparedImage, contentVersion: current.source.version };
      } catch (error) {
        if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ConflictError) throw error;
        throw new Error("Prepared image validation failed");
      }
    },
    /**
     * Registers an already-rendered Reel MP4 (inside MEDIA_ASSET_DIR, generated name) as the
     * content's prepared asset: fingerprint = sha256 of the file, outputPath = public Reel path.
     * `sourcePhotoId` must be one of the content's selected Ready photos (the Reel's source).
     */
    async prepareReel(contentId: string, sourcePhotoId: string, assetFile: string) {
      const name = path.basename(assetFile);
      if (path.resolve(assetFile) !== reelFilePath(name) || !path.resolve(assetFile).startsWith(mediaAssetDir() + path.sep)) throw new BadRequestError("Reel asset is not a managed media asset");
      const publicPath = `${REEL_PUBLIC_PATH}/${name}`;
      const inspected = await inspectPreparedReel(publicPath);
      if (!inspected) throw new BadRequestError("Reel asset is missing or is not a valid MP4");
      return repository.transaction(function* (tx) {
        yield* repository.source(tx, contentId, sourcePhotoId); // content exists, photo is selected + Ready
        return yield* repository.persist(tx, contentId, sourcePhotoId, { sourceFingerprint: inspected.sha256, recipeVersion: INSTAGRAM_REEL_RECIPE, outputPath: publicPath } as any);
      });
    },
    async prepare(contentId: string, photoId: string, publicOrigin: string, recipeId: InstagramImageRecipe = INSTAGRAM_IMAGE_RECIPE) {
      const before = await repository.transaction(function* (tx) { return yield* repository.source(tx, contentId, photoId); });
      // Filesystem work stays outside the DB transaction; retries validate/reuse the derivative.
      const asset = await render({ url: before.url }, publicOrigin, undefined, undefined, recipeId);
      return repository.transaction(function* (tx) {
        const current = yield* repository.source(tx, contentId, photoId);
        if (JSON.stringify(current) !== JSON.stringify(before)) throw new ConflictError("Selected media changed during preparation");
        const result = yield* repository.persist(tx, contentId, photoId, asset);
        return { ...result, url: asset.url };
      });
    },
  };
}
