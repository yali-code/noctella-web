/**
 * FAZ A / #424 W2 live adoption, real HTTP route (production router, real auth, real SQLite, real filesystem)
 * with PHOTO_OWNERSHIP_FENCING_ENABLED=true: one committed operation/photo/outbox per request identity, identical
 * retries are idempotent, conflicting retries are 409, deterministic no-overwrite publication.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { AdminRole, ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w2-live-"));
  Object.assign(process.env, {
    DATABASE_URL: ":memory:", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "w2-live-state",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
  });
  return { root };
});

let app: import("express").Express, db: any, cookie: string, productId: string, front: Buffer, back: Buffer;
const count = async (table: string) => Number((db.all(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0].n);
const post = (key?: string) => { const r = request(app).post(`/api/products/${productId}/photos`).set("Cookie", cookie); return key ? r.set("Idempotency-Key", key) : r; };

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  const { createAdminUser } = await import("../src/services/adminAuth");
  await createAdminUser(db, { email: "w2-editor@offline.test", role: AdminRole.ProductEditor, password: "offline-password-123" });
  const login = await request(app).post("/api/auth/login").send({ email: "w2-editor@offline.test", password: "offline-password-123" });
  cookie = String(login.headers["set-cookie"][0]).split(";")[0];
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "W2", displayOrder: 0, isActive: true });
  productId = (await (await import("../src/services/products")).createProduct(db, { sku: "W2-LIVE", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
  front = await sharp({ create: { width: 90, height: 60, channels: 3, background: "#806040" } }).jpeg().toBuffer();
  back = await sharp({ create: { width: 90, height: 60, channels: 3, background: "#204080" } }).jpeg().toBuffer();
}, 60_000);
afterAll(async () => { await (await import("../src/db/client")).dbRuntime.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it("a fenced upload commits exactly one operation, photo and promote outbox event at deterministic keys", async () => {
  const res = await post("w2-live-key-0000000001").field("altText", "Front").attach("photo", front, "front.jpg");
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ productId, altText: "Front", isPrimary: true, mimeType: "image/webp", sizeBytes: front.length });
  const [op] = db.all(sql`SELECT state, generation, target_photo_id, main_key, thumb_key, committed_photo_id FROM photo_operations`) as any[];
  expect(op).toMatchObject({ state: "committed", generation: 1, target_photo_id: res.body.id, committed_photo_id: res.body.id });
  expect(path.basename(res.body.url)).toBe(op.main_key);
  expect(path.basename(res.body.thumbnailUrl)).toBe(op.thumb_key);
  expect(db.all(sql`SELECT operation_id FROM photo_w2_upload_intents WHERE token = 'w2-live-key-0000000001'`)).toHaveLength(1);
  expect([await count("photo_operations"), await count("product_photos"), await count("outbox_events")]).toEqual([1, 1, 1]);
  expect((await readdir(path.join(root, "photos"))).sort()).toEqual([op.main_key, op.thumb_key].sort());
  expect(await readdir(path.join(root, ".product-photo-upload-staging"))).toEqual([]);
});

it("an identical retry returns the committed photo without new rows, events or files", async () => {
  const before = await readFile(path.join(root, "photos", (await readdir(path.join(root, "photos")))[0]));
  const res = await post("w2-live-key-0000000001").field("altText", "Front").attach("photo", front, "front.jpg");
  expect(res.status).toBe(201);
  const [op] = db.all(sql`SELECT committed_photo_id FROM photo_operations`) as any[];
  expect(res.body.id).toBe(op.committed_photo_id);
  expect([await count("photo_operations"), await count("product_photos"), await count("outbox_events")]).toEqual([1, 1, 1]);
  expect(await readdir(path.join(root, "photos"))).toHaveLength(2);
  expect(await readFile(path.join(root, "photos", (await readdir(path.join(root, "photos")))[0]))).toEqual(before);
});

it("a conflicting retry (same key, different bytes or alt text) is 409 and changes nothing", async () => {
  const bytes = await post("w2-live-key-0000000001").field("altText", "Front").attach("photo", back, "back.jpg");
  const alt = await post("w2-live-key-0000000001").field("altText", "Other").attach("photo", front, "front.jpg");
  for (const res of [bytes, alt]) { expect(res.status).toBe(409); expect(res.body.code).toBe("PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT"); }
  expect([await count("photo_operations"), await count("product_photos"), await count("outbox_events")]).toEqual([1, 1, 1]);
});

it("uploads without a key get a server-generated identity: distinct requests stay distinct, each exactly once", async () => {
  const a = await post().attach("photo", back, "back.jpg");
  const b = await post().attach("photo", back, "back.jpg");
  expect([a.status, b.status]).toEqual([201, 201]);
  expect(a.body.id).not.toBe(b.body.id);
  expect([await count("photo_operations"), await count("product_photos"), await count("outbox_events")]).toEqual([3, 3, 3]);
  expect(db.all(sql`SELECT state FROM photo_operations WHERE state <> 'committed'`)).toEqual([]);
  expect(await readdir(path.join(root, ".product-photo-operations"))).toHaveLength(3);
});

it("an invalid image with a fresh key commits nothing and publishes nothing", async () => {
  const prior = (await readdir(path.join(root, "photos"))).sort();
  const res = await post("w2-live-key-invalid-00001").attach("photo", Buffer.from("not an image"), "x.jpg");
  expect(res.status).toBe(400);
  expect((await readdir(path.join(root, "photos"))).sort()).toEqual(prior);
  expect([await count("product_photos"), await count("outbox_events")]).toEqual([3, 3]);
  expect(db.all(sql`SELECT state, review_reason FROM photo_operations WHERE subject_id = 'w2-live-key-invalid-00001'`)).toEqual([{ state: "review", review_reason: "input rejected: PHOTO_UPLOAD_INVALID" }]);
  const retry = await post("w2-live-key-invalid-00001").attach("photo", Buffer.from("not an image"), "x.jpg");
  expect(retry.status).toBe(409);
  expect(retry.body.code).toBe("PHOTO_OPERATION_REVIEW");
});
