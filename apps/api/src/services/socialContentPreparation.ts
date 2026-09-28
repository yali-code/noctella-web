import type { DbClient } from "../db/client";
import { prepareInstagramImageAsset } from "../integrations/instagram/mediaPreparation";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { ConflictError } from "./errors";

/** Internal image preparation only: no route, provider or publishing side effect. */
export function createSocialContentPreparationService(
  db: DbClient,
  driver = process.env.DATABASE_DRIVER ?? "sqlite",
  render: typeof prepareInstagramImageAsset = prepareInstagramImageAsset,
) {
  const repository = createPreparedImageRepository(db, driver);
  return {
    async prepare(contentId: string, photoId: string, publicOrigin: string) {
      const before = await repository.transaction(function* (tx) { return yield* repository.source(tx, contentId, photoId); });
      // Filesystem work stays outside the DB transaction; retries validate/reuse the derivative.
      const asset = await render({ url: before.url }, publicOrigin);
      return repository.transaction(function* (tx) {
        const current = yield* repository.source(tx, contentId, photoId);
        if (JSON.stringify(current) !== JSON.stringify(before)) throw new ConflictError("Selected media changed during preparation");
        const result = yield* repository.persist(tx, contentId, photoId, asset);
        return { ...result, url: asset.url };
      });
    },
  };
}
