import { asc, gt } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { productPhotos } from "../../db/schema";
import type { ProductPhotoBackupReferenceSource } from "./types";

const external = (value: string) => /^https?:\/\//i.test(value);
const filenameFromLocalUrl = (value: string) => {
  if (!value.startsWith("/images/product-photos/")) return undefined;
  const name = value.slice("/images/product-photos/".length);
  return name && !name.includes("/") ? name : undefined;
};

export function createProductPhotoBackupReferenceSource(db: DbClient): ProductPhotoBackupReferenceSource {
  return {
    async listPage(cursor, limit) {
      const query = db.select().from(productPhotos).where(cursor ? gt(productPhotos.id, cursor) : undefined).orderBy(asc(productPhotos.id)).limit(limit + 1);
      const rows = await query;
      const page = rows.slice(0, limit);
      const items = page.map((row) => {
        const mainExternal = external(row.url);
        const thumbnailExternal = external(row.thumbnailUrl);
        const hasMainStorageKey = Boolean(row.storageKey);
        const hasThumbnailStorageKey = Boolean(row.thumbnailStorageKey);
        if (hasMainStorageKey !== hasThumbnailStorageKey) throw new Error("Local product photo storage metadata is incomplete");
        if (mainExternal !== thumbnailExternal) throw new Error("Product photo ownership metadata is inconsistent");
        if (hasMainStorageKey && mainExternal) throw new Error("Product photo ownership metadata is inconsistent");
        if (mainExternal) return { photoId: row.id, productId: row.productId, mimeType: row.mimeType, locallyOwned: false };
        const localMainUrlKey = filenameFromLocalUrl(row.url);
        const localThumbnailUrlKey = filenameFromLocalUrl(row.thumbnailUrl);
        if (!hasMainStorageKey && (!localMainUrlKey || !localThumbnailUrlKey)) throw new Error("Product photo ownership metadata is inconsistent");
        const mainStorageKey = row.storageKey ?? localMainUrlKey;
        const thumbnailStorageKey = row.thumbnailStorageKey ?? localThumbnailUrlKey;
        if (!mainStorageKey || !thumbnailStorageKey) throw new Error("Local product photo storage metadata is incomplete");
        return { photoId: row.id, productId: row.productId, mimeType: row.mimeType, locallyOwned: true, mainStorageKey, thumbnailStorageKey };
      });
      return { items, nextCursor: rows.length > limit ? page[page.length - 1]?.id : undefined };
    },
  };
}
