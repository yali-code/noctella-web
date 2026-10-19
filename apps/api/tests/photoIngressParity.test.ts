/**
 * #472 daily-use parity, photo ingress, over the REAL routers with fencing ON (protected mode):
 * - ERP photo upload goes through the protected W2 owner (actor erp:<client>), with an optional stable Idempotency-Key;
 * - the admin upload route uses the protected owner even when the disk-staging flag is OFF (no legacy W1 fallback);
 * - AI-intake photo staging (W3, private non-canonical root) stays available, so W4 finalization is usable.
 * Fencing-OFF compatibility of the ERP legacy route is asserted separately (no photo operation, W1 semantics).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { AdminRole, ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-ingress-parity-"));
  Object.assign(process.env, {
    DATABASE_URL: ":memory:", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "false",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"), ERP_INTEGRATION_KEY: "ingress-parity-erp-key",
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "ingress-parity",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
  });
  delete process.env.DATABASE_DRIVER;
  return { root };
});
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let app: import("express").Express, db: any, cookie: string, productId: string, a: Buffer, b: Buffer;
const count = (table: string, where = "") => Number(db.all(sql.raw(`SELECT COUNT(*) AS n FROM ${table} ${where}`))[0].n);
const erp = (key?: string) => {
  const r = request(app).post(`/api/erp/products/${productId}/photos/upload`).set("X-Noctella-ERP-Key", "ingress-parity-erp-key").set("X-Noctella-ERP-Client-Version", "0.1.0");
  return key ? r.set("Idempotency-Key", key) : r;
};

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  const { createAdminUser } = await import("../src/services/adminAuth");
  await createAdminUser(db, { email: "ingress@offline.test", role: AdminRole.Owner, password: "offline-password-123" });
  const login = await request(app).post("/api/auth/login").send({ email: "ingress@offline.test", password: "offline-password-123" });
  cookie = String(login.headers["set-cookie"][0]).split(";")[0];
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Ingress", displayOrder: 0, isActive: true });
  productId = (await (await import("../src/services/products")).createProduct(db, { sku: "INGRESS-1", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
  a = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#704020" } }).jpeg().toBuffer();
  b = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#207040" } }).jpeg().toBuffer();
});
afterAll(async () => { await (await import("../src/db/client")).dbRuntime.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

describe("ERP photo upload in protected mode", () => {
  it("commits through the protected W2 owner with the ERP client as actor and is audited", async () => {
    const res = await erp("erp-ingress-key-000000001").attach("photo", a, "a.jpg");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ productId, mimeType: "image/webp" });
    const [intent] = db.all(sql`SELECT actor_id, operation_id FROM photo_w2_upload_intents WHERE token = 'erp-ingress-key-000000001'`) as any[];
    expect(intent.actor_id).toBe("erp:env");
    expect((db.all(sql`SELECT state FROM photo_operations WHERE id = ${intent.operation_id}`) as any[])[0].state).toBe("committed");
    expect((db.all(sql`SELECT state FROM photo_publication_intents WHERE operation_id = ${intent.operation_id}`) as any[])[0].state).toBe("committed");
    await new Promise((r) => setTimeout(r, 50));
    expect(count("erp_integration_audit", "WHERE action = 'ErpPhotoUpload' AND result = 'Succeeded'")).toBeGreaterThanOrEqual(1);
  });

  it("a retry (lost acknowledgement) with the same key returns the same photo; concurrent retries yield one photo", async () => {
    const first = await erp("erp-ingress-key-000000002").attach("photo", b, "b.jpg");
    const photos = count("product_photos");
    const retry = await erp("erp-ingress-key-000000002").attach("photo", b, "b.jpg");
    expect([first.status, retry.status, retry.body.id]).toEqual([201, 201, first.body.id]);
    const concurrent = await Promise.all([1, 2, 3].map(() => erp("erp-ingress-key-000000003").attach("photo", a, "a.jpg")));
    const ok = concurrent.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    for (const r of concurrent.filter((x) => x.status !== 201)) expect(r.body.code).toBe("PHOTO_OPERATION_IN_PROGRESS");
    expect(count("product_photos")).toBe(photos + 1);
  });

  it("a conflicting reuse of a key is refused; requests without a key are distinct uploads (no silent dedup by bytes)", async () => {
    const conflict = await erp("erp-ingress-key-000000002").attach("photo", a, "a.jpg");
    expect([conflict.status, conflict.body.code]).toEqual([409, "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT"]);
    const before = count("product_photos");
    const x = await erp().attach("photo", a, "a.jpg"), y = await erp().attach("photo", a, "a.jpg");
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.id).not.toBe(y.body.id);
    expect(count("product_photos")).toBe(before + 2);
  });

  it("refuses before any write: unknown product (404), invalid key (400), missing ERP auth (401)", async () => {
    const operations = count("photo_operations");
    const missing = await request(app).post("/api/erp/products/no-such-product/photos/upload").set("X-Noctella-ERP-Key", "ingress-parity-erp-key").set("X-Noctella-ERP-Client-Version", "0.1.0").attach("photo", a, "a.jpg");
    expect(missing.status).toBe(404);
    expect((await erp("short").attach("photo", a, "a.jpg")).status).toBe(400);
    expect((await request(app).post(`/api/erp/products/${productId}/photos/upload`).attach("photo", a, "a.jpg")).status).toBe(401);
    expect(count("photo_operations")).toBe(operations);
  });
});

describe("admin and AI-intake ingress in protected mode", () => {
  it("the admin route uses the protected owner even with PRODUCT_PHOTO_DISK_STAGING_ENABLED=false (no W1 fallback)", async () => {
    const res = await request(app).post(`/api/products/${productId}/photos`).set("Cookie", cookie).set("Idempotency-Key", "admin-ingress-key-00000001").attach("photo", b, "b.jpg");
    expect(res.status).toBe(201);
    expect(count("photo_w2_upload_intents", "WHERE token = 'admin-ingress-key-00000001'")).toBe(1);
  });

  it("AI-intake photo staging (private W3 root) is accepted with fencing ON when disk staging is enabled", async () => {
    process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = "true";
    try {
      const freshApp = app;
      const intake = await request(freshApp).post("/api/ai-product-intakes").set("Cookie", cookie).send({});
      expect(intake.status).toBe(201);
      const staged = await request(freshApp).post(`/api/ai-product-intakes/${intake.body.id}/photos`).set("Cookie", cookie).attach("photo", a, "a.jpg");
      expect(staged.status).toBe(201);
      expect(fs.readdirSync(path.join(root, "photos")).some((f) => f.includes(intake.body.id))).toBe(false); // never canonical
    } finally { process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = "false"; }
  });
});

describe("fencing OFF compatibility", () => {
  it("the ERP legacy route is unchanged (W1 semantics, no photo operation)", async () => {
    process.env.PHOTO_OWNERSHIP_FENCING_ENABLED = "false";
    try {
      const operations = count("photo_operations");
      const res = await erp().attach("photo", b, "b.jpg");
      expect(res.status).toBe(201);
      expect(count("photo_operations")).toBe(operations);
    } finally { process.env.PHOTO_OWNERSHIP_FENCING_ENABLED = "true"; }
  });
});
