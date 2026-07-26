// Sprint 71: end-to-end proof that the real scheduler endpoint (POST /api/background-jobs/run)
// drives the product-photo outbox dispatcher against the real LocalPhotoStorage - not a mocked
// storage - and that a promoted photo becomes visible on the public product endpoint while its
// files remain on disk. db/client.ts and photoStorage.ts read env vars at import time, so these
// must be set before src/app.ts (which transitively imports both) is ever imported.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { ProductStatus, ProductType } from "@noctella/shared";

let photoDir: string;

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token";

beforeAll(async () => {
  photoDir = await fs.mkdtemp(path.join(os.tmpdir(), "noctella-photo-scheduler-"));
  process.env.PRODUCT_PHOTO_DIR = photoDir;
});

describe("product photo outbox dispatch via the scheduler endpoint (Sprint 71)", () => {
  it("promotes a Processing photo to Ready via the real LocalPhotoStorage, keeps its files, runs alongside runDueJobs, and exposes the photo publicly", async () => {
    // Real sharp image processing + multiple real HTTP round-trips through the full app can
    // exceed vitest's default 5s test timeout on a cold run.
    const { default: app } = await import("../src/app");
    const { db } = await import("../src/db/client");
    const { uploadProductPhoto } = await import("../src/services/products");
    const { productPhotos, products } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");

    const productId = "outbox-e2e-product";
    await db.insert(products).values({
      id: productId,
      slug: "outbox-e2e-product",
      sku: "SKU-OUTBOX-E2E",
      title: "Outbox Dispatcher E2E Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
    });

    const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const photo = await uploadProductPhoto(db, productId, { buffer, mimetype: "image/png", size: buffer.length });
    expect(photo.processingStatus).toBe("Processing");

    const [beforeRow] = await db.select().from(productPhotos).where(eq(productPhotos.id, photo.id));
    const mainPath = path.join(photoDir, beforeRow.storageKey as string);
    const thumbPath = path.join(photoDir, beforeRow.thumbnailStorageKey as string);
    await expect(fs.access(mainPath)).resolves.toBeUndefined();
    await expect(fs.access(thumbPath)).resolves.toBeUndefined();

    const res = await request(app)
      .post("/api/background-jobs/run")
      .set("Authorization", "Bearer test-scheduler-token")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("processed");
    expect(res.body.photoOutboxProcessed).toBeGreaterThanOrEqual(1);

    const [afterRow] = await db.select().from(productPhotos).where(eq(productPhotos.id, photo.id));
    expect(afterRow.processingStatus).toBe("Ready");

    // The photo file must still be servable - promotion must never delete the live file when
    // LocalPhotoStorage's single upload directory doubles as both temp and permanent root.
    await expect(fs.access(mainPath)).resolves.toBeUndefined();
    await expect(fs.access(thumbPath)).resolves.toBeUndefined();

    const publicRes = await request(app).get("/api/public/products/outbox-e2e-product");
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.photos.some((p: any) => p.id === photo.id)).toBe(true);

    // Re-running the scheduler must not re-promote or fail on the now-Succeeded event.
    const secondRun = await request(app)
      .post("/api/background-jobs/run")
      .set("Authorization", "Bearer test-scheduler-token")
      .send({});
    expect(secondRun.status).toBe(200);
    expect(secondRun.body.photoOutboxProcessed).toBe(0);
  }, 20000);
});
