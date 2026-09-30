import type { DbClient } from "../db/client";
import { prepareInstagramImageAsset, inspectPreparedInstagramImage, INSTAGRAM_IMAGE_RECIPE, type InstagramImageRecipe } from "../integrations/instagram/mediaPreparation";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";

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
        const valid = await inspect({ url: before.source.url }, before.preparedImage);
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
