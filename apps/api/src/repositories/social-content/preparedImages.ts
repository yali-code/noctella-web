import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { BadRequestError, NotFoundError } from "../../services/errors";
import type { PreparedInstagramImage } from "../../integrations/instagram/mediaPreparation";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";

export interface PreparationSource {
  version: number;
  selectionId: string;
  photoId: string;
  productId: string;
  url: string;
  storageKey: string | null;
  updatedAt: string;
}
export interface SocialPreparedImage {
  id: string;
  contentId: string;
  sourcePhotoId: string;
  sourceFingerprint: string;
  recipeVersion: string;
  outputPath: string;
}

export function createPreparedImageRepository(db: DbClient, driver: string) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContents: contents, socialContentMedia: media, productPhotos: photos, socialPreparedImages: prepared } = sync ? sqlite : postgres;
  return {
    transaction: createSocialContentRepository(db, driver).transaction,
    *find(tx: any, contentId: string, id: string): SocialWork<SocialPreparedImage> {
      let query = tx.select().from(prepared).where(and(eq(prepared.contentId, contentId), eq(prepared.id, id)));
      if (!sync) query = query.for("share");
      const [row] = yield query;
      if (!row) throw new NotFoundError("Prepared image not found for content");
      return row;
    },
    *source(tx: any, contentId: string, photoId: string): SocialWork<PreparationSource> {
      let contentQuery = tx.select().from(contents).where(eq(contents.id, contentId));
      if (!sync) contentQuery = contentQuery.for("update");
      const [content] = yield contentQuery;
      if (!content) throw new NotFoundError("Social content not found");
      if (content.platform !== "instagram" || content.accountLabel !== "vault") throw new BadRequestError("Unsupported social preparation target");
      let selectionQuery = tx.select().from(media).where(and(eq(media.contentId, contentId), eq(media.photoId, photoId)));
      if (!sync) selectionQuery = selectionQuery.for("share");
      const [selection] = yield selectionQuery;
      if (!selection) throw new BadRequestError("Photo is not selected for this content");
      let photoQuery = tx.select().from(photos).where(eq(photos.id, photoId));
      if (!sync) photoQuery = photoQuery.for("share");
      const [photo] = yield photoQuery;
      if (!photo || photo.processingStatus !== "Ready" || (content.productId && photo.productId !== content.productId)) {
        throw new BadRequestError("Selected media must be ready and belong to the selected product");
      }
      return { version: content.version, selectionId: selection.id, photoId, productId: photo.productId,
        url: photo.url, storageKey: photo.storageKey, updatedAt: photo.updatedAt instanceof Date ? photo.updatedAt.toISOString() : photo.updatedAt };
    },
    *persist(tx: any, contentId: string, photoId: string, asset: PreparedInstagramImage): SocialWork<SocialPreparedImage> {
      const identity = { contentId, sourcePhotoId: photoId, sourceFingerprint: asset.sourceFingerprint, recipeVersion: asset.recipeVersion };
      yield tx.insert(prepared).values({ id: randomUUID(), ...identity, outputPath: asset.outputPath }).onConflictDoNothing().returning();
      return (yield tx.select().from(prepared).where(and(eq(prepared.contentId, contentId), eq(prepared.sourcePhotoId, photoId),
        eq(prepared.sourceFingerprint, identity.sourceFingerprint), eq(prepared.recipeVersion, identity.recipeVersion))))[0];
    },
  };
}
