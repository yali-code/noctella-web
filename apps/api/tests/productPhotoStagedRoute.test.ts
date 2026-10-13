import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdminRole, ProductStatus, ProductType } from "@noctella/shared";
const root = mkdtempSync(path.join(os.tmpdir(), "noctella-staged-route-"));
Object.assign(process.env, { DATABASE_URL: ":memory:", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PRODUCT_PHOTO_DIR: path.join(root, "photos"), AI_INTAKE_PHOTO_DIR: path.join(root, "intake"), MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "offline-test-state", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000", SCHEDULER_AUTH_TOKEN: "offline-test-scheduler" });
let app: import("express").Express, db: any, cookie: string, forbidden: string, productId: string, bytes: Buffer;
beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  const { createAdminUser } = await import("../src/services/adminAuth");
  for (const [email, role] of [["editor@offline.test", AdminRole.ProductEditor], ["reviewer@offline.test", AdminRole.AiReviewer]] as const) {
    await createAdminUser(db, { email, role, password: "offline-password-123" });
    const login = await request(app).post("/api/auth/login").send({ email, password: "offline-password-123" });
    const token = String(login.headers["set-cookie"][0]).split(";")[0];
    if (role === AdminRole.ProductEditor) cookie = token; else forbidden = token;
  }
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Offline", displayOrder: 0, isActive: true });
  const product = await (await import("../src/services/products")).createProduct(db, { sku: "STAGED-ROUTE", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
  productId = product.id;
  bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#a08040" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
});
afterAll(async () => { await (await import("../src/db/client")).dbRuntime.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
const post = () => request(app).post(`/api/products/${productId}/photos`);
it("enforces real authentication and permission before staging", async () => {
  expect((await post().attach("photo", bytes, "x.jpg")).status).toBe(401);
  expect((await post().set("Cookie", forbidden).attach("photo", bytes, "x.jpg")).status).toBe(403);
  expect(await readdir(root)).toEqual([]);
});
it("preserves photo response, ordering, primary, alt text, recipe bytes and promotion outbox", async () => {
  const first = await post().set("Cookie", cookie).field("altText", "Front").attach("photo", bytes, "x.jpg");
  const second = await post().set("Cookie", cookie).field("altText", "Back").attach("photo", bytes, "x.jpg");
  expect(first.status).toBe(201); expect(second.status).toBe(201);
  expect(first.body).toMatchObject({ productId, altText: "Front", isPrimary: true, sortOrder: 0, width: 40, height: 80, sizeBytes: bytes.length, mimeType: "image/webp" });
  expect(second.body).toMatchObject({ productId, altText: "Back", isPrimary: false, sortOrder: 1 });
  expect(second.body.id).not.toBe(first.body.id);
  const { outboxEvents } = await import("../src/db/schema");
  const events = await db.select().from(outboxEvents);
  const { OutboxEventType } = await import("../src/domain/outboxContracts"); expect(events).toHaveLength(2); expect(events.every((event: any) => event.eventType === OutboxEventType.ProductPhotoPromoteRequested)).toBe(true);
  const legacy = new (await import("../src/services/photoStorage")).LocalPhotoStorage();
  const saved = await legacy.saveProductPhoto({ buffer: bytes, size: bytes.length, mimetype: "image/jpeg" });
  expect(await readFile(path.join(root, "photos", path.basename(first.body.url)))).toEqual(await readFile(path.join(root, "photos", saved.filename)));
  expect(await readFile(path.join(root, "photos", path.basename(first.body.thumbnailUrl)))).toEqual(await readFile(path.join(root, "photos", path.basename(saved.thumbnailUrl))));
  expect(await readdir(path.join(root, ".product-photo-upload-staging"))).toEqual([]);
});
it("invalid images produce no rows, files or outbox changes", async () => {
  const prior = await readdir(path.join(root, "photos"));
  const result = await post().set("Cookie", cookie).attach("photo", Buffer.from("invalid"), "x.jpg");
  expect(result.status).toBe(400); expect(result.body.code).toBe("PHOTO_UPLOAD_INVALID");
  expect(await readdir(path.join(root, "photos"))).toEqual(prior);
  expect(await readdir(path.join(root, ".product-photo-upload-staging"))).toEqual([]);
});




