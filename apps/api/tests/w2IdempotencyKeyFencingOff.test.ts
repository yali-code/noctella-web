/**
 * #424 admin Idempotency-Key compatibility: with PHOTO_OWNERSHIP_FENCING_ENABLED OFF (production default) the W2
 * route ignores the header entirely, so the admin client sending it changes nothing. Real HTTP route, real auth,
 * real SQLite and filesystem; no ownership rows are written.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { AdminRole, ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w2-key-off-"));
  Object.assign(process.env, {
    DATABASE_URL: ":memory:", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "false",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "w2-key-off-state",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
  });
  return { root };
});

let app: import("express").Express, db: any, cookie: string, productId: string, front: Buffer;
const count = (table: string) => Number((db.all(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0].n);
const post = (key: string) => request(app).post(`/api/products/${productId}/photos`).set("Cookie", cookie).set("Idempotency-Key", key);

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  const { createAdminUser } = await import("../src/services/adminAuth");
  await createAdminUser(db, { email: "w2-key-off@offline.test", role: AdminRole.ProductEditor, password: "offline-password-123" });
  const login = await request(app).post("/api/auth/login").send({ email: "w2-key-off@offline.test", password: "offline-password-123" });
  cookie = String(login.headers["set-cookie"][0]).split(";")[0];
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "W2 off", displayOrder: 0, isActive: true });
  productId = (await (await import("../src/services/products")).createProduct(db, { sku: "W2-KEY-OFF", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
  front = await sharp({ create: { width: 90, height: 60, channels: 3, background: "#806040" } }).jpeg().toBuffer();
}, 60_000);
afterAll(async () => { await (await import("../src/db/client")).dbRuntime.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it("fencing OFF: a client key is accepted and ignored (legacy behavior, no ownership rows)", async () => {
  const a = await post("4f7a1c2e-0b9d-4c51-9a37-6e2d8b1f0c44").field("altText", "Front").attach("photo", front, "front.jpg");
  const b = await post("4f7a1c2e-0b9d-4c51-9a37-6e2d8b1f0c44").field("altText", "Front").attach("photo", front, "front.jpg");
  expect([a.status, b.status]).toEqual([201, 201]);
  expect(a.body.id).not.toBe(b.body.id); // no server deduplication without fencing (unchanged behavior)
  expect(count("product_photos")).toBe(2);
  expect([count("photo_operations"), count("photo_w2_upload_intents")]).toEqual([0, 0]);
});

it("fencing OFF: even a malformed key is not validated (the header is not part of the legacy contract)", async () => {
  const res = await post("bad key!").attach("photo", front, "front.jpg");
  expect(res.status).toBe(201);
});
