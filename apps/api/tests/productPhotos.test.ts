import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createCategory } from "../src/services/categories";
import { BadRequestError } from "../src/services/errors";
import type { PhotoStorage } from "../src/services/photoStorage";
import { PRODUCT_PHOTO_MAX_BYTES, LocalPhotoStorage } from "../src/services/photoStorage";
import {
  createProduct,
  deleteProductPhoto,
  reorderProductPhotos,
  setPrimaryProductPhoto,
  updateProductPhoto,
  uploadProductPhoto,
} from "../src/services/products";
import { createTestDb } from "./testDb";
import { outboxEvents } from "../src/db/schema";

function mockStorage(): PhotoStorage {
  let counter = 0;
  return {
    saveProductPhoto: vi.fn(async () => {
      counter += 1;
      return {
        filename: `photo-${counter}.webp`,
        url: `/images/product-photos/photo-${counter}.webp`,
        thumbnailUrl: `/images/product-photos/photo-${counter}-thumb.webp`,
        mimeType: "image/webp",
        sizeBytes: 123,
        width: 1600,
        height: 1200,
      };
    }),
    deleteProductPhoto: vi.fn(async () => {}),
  };
}

describe("product photo workflow", () => {
  let db: ReturnType<typeof createTestDb>;
  let productId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Decor", displayOrder: 0, isActive: true });
    const product = await createProduct(db, {
      sku: "PHOTO-001",
      title: "Bronze Lamp",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 250,
      images: [{ url: "https://legacy.example/lamp.jpg", sortOrder: 0, isPrimary: true }],
    });
    productId = product.id;
  });

  it("uploads photos, prefers them over legacy images, updates alt text, reorders, and sets primary", async () => {
    const storage = mockStorage();
    const first = await uploadProductPhoto(db, productId, { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 }, "Front", storage);
    const second = await uploadProductPhoto(db, productId, { buffer: Buffer.from("b"), mimetype: "image/jpeg", size: 1 }, "Back", storage);

    expect(first.isPrimary).toBe(true);
    expect(second.isPrimary).toBe(false);
    let detail = await updateProductPhoto(db, productId, second.id, "Rear view");
    expect(detail.altText).toBe("Rear view");

    await reorderProductPhotos(db, productId, [second.id, first.id]);
    const photos = await setPrimaryProductPhoto(db, productId, second.id);
    expect(photos.map((photo) => photo.id)).toEqual([second.id, first.id]);
    expect(photos.find((photo) => photo.id === second.id)?.isPrimary).toBe(true);

    const product = await createProduct(db, {
      sku: "LEGACY-ONLY",
      title: "Legacy Only",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId: (await createCategory(db, { name: "Legacy", displayOrder: 1, isActive: true })).id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      images: [{ url: "https://legacy.example/only.jpg", sortOrder: 0, isPrimary: true }],
    });
    expect(product.photos).toEqual([]);
    expect(product.images[0].url).toBe("https://legacy.example/only.jpg");
  });

  it("enqueues outbox deletion without synchronous physical delete", async () => {
    const storage = mockStorage();
    const photo = await uploadProductPhoto(db, productId, { buffer: Buffer.from("a"), mimetype: "image/webp", size: 1 }, undefined, storage);
    const remaining = await deleteProductPhoto(db, productId, photo.id, storage);
    expect(remaining).toEqual([]);
    expect(storage.deleteProductPhoto).not.toHaveBeenCalled();
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, photo.id));
    expect(events.some((event) => event.eventType === "product_photo.delete_requested")).toBe(true);
  });

  it("rolls back uploaded files if database persistence fails", async () => {
    const storage = mockStorage();
    const failingDb = Object.create(db) as typeof db;
    failingDb.insert = vi.fn(() => {
      throw new Error("insert failed");
    }) as never;
    await expect(
      uploadProductPhoto(failingDb, productId, { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 }, undefined, storage),
    ).rejects.toThrow("insert failed");
    expect(storage.deleteProductPhoto).toHaveBeenCalled();
  });

  it("validates mime type and max upload size in local storage", async () => {
    const storage = new LocalPhotoStorage();
    await expect(storage.saveProductPhoto({ buffer: Buffer.from("x"), mimetype: "image/gif", size: 1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(storage.saveProductPhoto({ buffer: Buffer.from("x"), mimetype: "image/png", size: PRODUCT_PHOTO_MAX_BYTES + 1 })).rejects.toBeInstanceOf(BadRequestError);
  });
});
