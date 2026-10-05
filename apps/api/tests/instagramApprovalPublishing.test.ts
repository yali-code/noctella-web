import express from "express";
import request from "supertest";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createInstagramRouter } from "../src/routes/instagram";
import { createAdminUser, login } from "../src/services/adminAuth";
import { createSocialContentService } from "../src/services/socialContent";
import * as preparation from "../src/services/socialContentPreparation";
import { encryptCredential } from "../src/services/credentialEncryption";
import { INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../src/integrations/instagram/types";

let db: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof express>;
let cookie: string;
let actorId: string;
let approvalId: string;
const originalFactory = preparation.createSocialContentPreparationService;
const inspect = vi.fn();
const render = vi.fn();
const calls: string[] = [];
let providerBodies: Array<Record<string, string>>;
let transport: InstagramTransport;
const env = { DATABASE_DRIVER: "test-memory", PUBLIC_API_ORIGIN: "https://api.example.test",
  INSTAGRAM_API_VERSION: "v24.0", INSTAGRAM_ALLOWED_ACCOUNT_IDS: INSTAGRAM_VAULT_ACCOUNT_ID,
  INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" };
const body = () => ({ approvalId, idempotencyKey: "publish-key-001" });
const post = (value: unknown = body()) => request(app).post("/api/instagram/publish").set("Cookie", cookie).send(value);
const attempts = () => db.select().from(schema.instagramPublishAttempts).all();
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  db = createTestDb(); calls.length = 0; providerBodies = [];
  inspect.mockReset().mockResolvedValue(true);
  render.mockReset().mockRejectedValue(new Error("Publishing must not prepare"));
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) =>
    originalFactory(client, "test-memory", render, inspect));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live request"));
  await createAdminUser(db, { email: "human@example.test", password: "safe-test-password-123", role: "owner" });
  actorId = db.select().from(schema.adminUsers).get()!.id;
  const session = await login(db, { email: "human@example.test", password: "safe-test-password-123" });
  cookie = `noctella_admin_session=${session.rawToken}`;
  db.insert(schema.marketplaceConnections).values({
    id: "connection", channel: "instagram", accountLabel: "vault", status: "connected",
    externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, encryptedAccessToken: encryptCredential("test-only"),
  }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready",
    url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp",
    mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  db.insert(schema.socialContents).values({
    id: "content", productId: "product", contentType: "post", caption: "Human-reviewed caption", status: "ready_for_review", version: 2,
  }).run();
  db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({
    id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64),
    recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-approved.jpg",
  }).run();
  approvalId = (await createSocialContentService(db, "test-memory").approve("content", {
    preparedImageId: "prepared", expectedVersion: 2, requestId: "aee22576-173d-4e1b-bd94-ae5261b1f619",
  }, actorId)).id;
  transport = vi.fn(async (url, init) => {
    // Even the first account verification must observe committed approval-bound authorization.
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0].approvalId).toBe(approvalId);
    expect((db as any).$client.inTransaction).toBe(false);
    calls.push(url);
    if (url.includes("/me?")) return response({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
    if (url.endsWith("/media")) {
      providerBodies.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return response({ id: "111" });
    }
    if (url.includes("/111?")) return response({ status_code: "FINISHED" });
    if (url.endsWith("/media_publish")) return response({ id: "222" });
    throw new Error("Unexpected mocked provider request");
  });
  app = express(); app.use(express.json()); app.use("/api/instagram", createInstagramRouter(db, transport, env));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});
it("approval alone creates neither publishing attempt nor provider activity", () => {
  expect(attempts()).toEqual([]); expect(calls).toEqual([]);
});
it("requires session, products.publish and trusted origin", async () => {
  expect((await request(app).post("/api/instagram/publish").send(body())).status).toBe(401);
  expect((await post().set("Origin", "https://evil.example.test")).status).toBe(403);
  db.update(schema.adminUsers).set({ role: "product_editor" }).run();
  expect((await post()).status).toBe(403); expect(calls).toEqual([]);
});
it.each(["approvalId", "idempotencyKey"])("requires %s", async (key) => {
  const value: Record<string, string> = body(); delete value[key];
  expect((await post(value)).status).toBe(400); expect(calls).toEqual([]);
});
it.each(["caption", "imageUrl", "mediaUrl", "preparedImageId", "contentId", "contentVersion", "actor", "adminUserId", "connectionId", "accountLabel"])("rejects caller override %s", async (key) => {
  expect((await post({ ...body(), [key]: "untrusted" })).status).toBe(400);
  expect(attempts()).toEqual([]); expect(calls).toEqual([]);
});
it("rejects nonexistent evidence and historical approved status alone", async () => {
  expect((await post({ ...body(), approvalId: "absent" })).status).toBe(404);
  expect(attempts()).toEqual([]); expect(calls).toEqual([]);
});
it.each(["version", "status", "target", "unselected", "not-ready", "invalid-artifact", "wrong-content"])("rejects stale binding %s before provider interaction", async (change) => {
  if (change === "version") db.update(schema.socialContents).set({ version: 4 }).run();
  if (change === "status") db.update(schema.socialContents).set({ status: "draft" }).run();
  if (change === "target") db.update(schema.socialContents).set({ productId: null }).run(); // use supported SQL constraints for target rejection below
  if (change === "target") (db as any).$client.exec("PRAGMA ignore_check_constraints=ON; UPDATE social_contents SET account_label='atelier'");
  if (change === "unselected") db.delete(schema.socialContentMedia).run();
  if (change === "not-ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (change === "invalid-artifact") inspect.mockResolvedValue(false);
  if (change === "wrong-content") {
    db.insert(schema.socialContents).values({ id: "other", contentType: "post" }).run();
    db.update(schema.socialPreparedImages).set({ contentId: "other" }).run();
  }
  expect([400, 404, 409]).toContain((await post()).status);
  expect(attempts()).toEqual([]); expect(calls).toEqual([]);
});
it("derives immutable delivery data, authorizes before network, and publishes once", async () => {
  const first = await post();
  expect(first.status).toBe(200); expect(first.body.status).toBe("published");
  expect(attempts()[0]).toMatchObject({ approvalId, caption: "Human-reviewed caption",
    mediaUrl: env.PUBLIC_API_ORIGIN + "/images/product-photos/instagram-v1-approved.jpg", connectionId: "connection" });
  expect(providerBodies).toEqual([{ image_url: attempts()[0].mediaUrl, caption: "Human-reviewed caption" }]);
  const count = calls.length;
  expect((await post()).body).toEqual(first.body);
  expect(calls).toHaveLength(count); expect(attempts()).toHaveLength(1);
});
it("permits a different authorized publishing human", async () => {
  await createAdminUser(db, { email: "publisher@example.test", password: "safe-test-password-123", role: "owner" });
  const session = await login(db, { email: "publisher@example.test", password: "safe-test-password-123" });
  cookie = `noctella_admin_session=${session.rawToken}`;
  expect((await post()).status).toBe(200);
});
it("conflicts on either publishing-key or approval reuse with a different binding", async () => {
  expect((await post()).status).toBe(200);
  const count = calls.length;
  expect((await post({ ...body(), approvalId: "different" })).status).toBe(409);
  expect((await post({ ...body(), idempotencyKey: "different-key" })).status).toBe(409);
  expect(attempts()).toHaveLength(1); expect(calls).toHaveLength(count);
});
it("does not resume an unbound historical attempt", async () => {
  db.insert(schema.instagramPublishAttempts).values({
    id: "historical", connectionId: "connection", idempotencyKey: body().idempotencyKey,
    caption: "Historical", mediaUrl: "https://api.example.test/old.jpg", status: "ready", containerId: "111",
  }).run();
  expect((await post()).status).toBe(409); expect(calls).toEqual([]);
  expect(attempts()[0].approvalId).toBeNull();
});
it("rechecks source state after inspection before committing authorization", async () => {
  vi.mocked(preparation.createSocialContentPreparationService).mockImplementation((client) => {
    const service = originalFactory(client, "test-memory", render, inspect);
    return { ...service, async validatePreparedImageCurrent(...args) {
      const result = await service.validatePreparedImageCurrent(...args);
      db.update(schema.productPhotos).set({ url: "/images/product-photos/replaced.webp" }).run();
      return result;
    } };
  });
  expect((await post()).status).toBe(409); expect(attempts()).toEqual([]); expect(calls).toEqual([]);
});
it("fails closed on attempt insertion failure before any network call", async () => {
  (db as any).$client.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON instagram_publish_attempts BEGIN SELECT RAISE(ABORT, 'failure'); END");
  expect((await post()).status).toBe(500); expect(calls).toEqual([]); expect(attempts()).toEqual([]);
});
