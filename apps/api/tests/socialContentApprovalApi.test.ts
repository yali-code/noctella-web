import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentRouter } from "../src/routes/socialContent";
import * as preparation from "../src/services/socialContentPreparation";
import { createAdminUser, login } from "../src/services/adminAuth";

let db: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof express>;
let cookie: string;
let actorId: string;
const endpoint = "/social/content/approve";
const input = { preparedImageId: "prepared", expectedVersion: 2, requestId: "aee22576-173d-4e1b-bd94-ae5261b1f619" };
const originalFactory = preparation.createSocialContentPreparationService;
const inspect = vi.fn();
const render = vi.fn();
const provider = vi.fn(() => { throw new Error("Unexpected provider construction"); });
const post = (body: unknown = input, url = endpoint) => request(app).post(url).set("Cookie", cookie).send(body);
const evidence = () => db.select().from(schema.socialContentApprovals).all();
const content = () => db.select().from(schema.socialContents).where(eq(schema.socialContents.id, "content")).get()!;

beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
  db = createTestDb();
  inspect.mockReset().mockResolvedValue(true);
  render.mockReset().mockRejectedValue(new Error("Approval must not render"));
  provider.mockClear();
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) =>
    originalFactory(client, "test-memory", render, inspect));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  app = express(); app.use(express.json()); app.use("/social", createSocialContentRouter(db, provider));
  await createAdminUser(db, { email: "human@example.test", password: "safe-test-password-123", role: "owner" });
  const session = await login(db, { email: "human@example.test", password: "safe-test-password-123" });
  cookie = `noctella_admin_session=${session.rawToken}`;
  actorId = db.select().from(schema.adminUsers).get()!.id;
  db.insert(schema.products).values({ id: "p", sku: "p", title: "p", slug: "p", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({
    id: "photo", productId: "p", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50,
  }).run();
  db.insert(schema.socialContents).values({
    id: "content", productId: "p", contentType: "post", caption: "Reviewed caption", status: "ready_for_review", version: 2,
  }).run();
  db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({
    id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64),
    recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-test.jpg",
  }).run();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  expect(db.select().from(schema.instagramPublishAttempts).all()).toEqual([]);
  expect(db.select().from(schema.outboxEvents).all()).toEqual([]);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});

it("persists session actor, database time, exact artifact and reviewed version atomically with approval", async () => {
  const photos = db.select().from(schema.productPhotos).all();
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    id: expect.any(String), requestId: input.requestId, contentId: "content", preparedImageId: "prepared",
    contentVersion: 2, approvedByAdminUserId: actorId, approvedAt: expect.any(String),
  });
  expect(Number.isNaN(Date.parse(response.body.approvedAt))).toBe(false);
  expect(evidence()).toEqual([response.body]);
  expect(content()).toMatchObject({ status: "approved", version: 3 });
  expect(db.select().from(schema.productPhotos).all()).toEqual(photos);
});
it("requires authenticated session and origin protection", async () => {
  expect((await request(app).post(endpoint).set("x-admin-role", "owner").send(input)).status).toBe(401);
  expect((await post().set("Origin", "https://untrusted.example.test")).status).toBe(403);
  expect(evidence()).toEqual([]);
});
it.each(["product_editor", "ai_reviewer"] as const)("requires both existing permissions (%s denied)", async (role) => {
  db.update(schema.adminUsers).set({ role }).where(eq(schema.adminUsers.id, actorId)).run();
  expect((await post()).status).toBe(403);
  expect(evidence()).toEqual([]);
});
it.each(["preparedImageId", "requestId", "expectedVersion"])("requires %s", async (key) => {
  const body: Record<string, unknown> = { ...input }; delete body[key];
  expect((await post(body)).status).toBe(400); expect(evidence()).toEqual([]);
});
it.each(["approvedBy", "approvedAt", "status", "publish", "provider", "approvedByAdminUserId"])("rejects caller field %s", async (key) => {
  expect((await post({ ...input, [key]: "untrusted" })).status).toBe(400); expect(evidence()).toEqual([]);
});
it("rejects the old generic approved transition even for an owner", async () => {
  expect((await post({ status: "approved", expectedVersion: 2 }, "/social/content/status")).status).toBe(400);
  expect(content().status).toBe("ready_for_review"); expect(evidence()).toEqual([]);
});
it("rejects an image belonging to another content and missing content", async () => {
  db.insert(schema.socialContents).values({ id: "other", contentType: "post", version: 2 }).run();
  expect((await post(input, "/social/other/approve")).status).toBe(404);
  expect((await post(input, "/social/missing/approve")).status).toBe(404);
  expect(evidence()).toEqual([]);
});
it.each(["invalid-file", "not-ready", "unselected"])("rejects stale/invalid source: %s", async (condition) => {
  if (condition === "invalid-file") inspect.mockResolvedValue(false);
  if (condition === "not-ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (condition === "unselected") db.delete(schema.socialContentMedia).run();
  expect((await post()).status).toBe(400);
  expect(evidence()).toEqual([]); expect(content().status).toBe("ready_for_review");
});
it("rejects stale reviewed version", async () => {
  expect((await post({ ...input, expectedVersion: 1 })).status).toBe(409);
  expect(evidence()).toEqual([]);
});
it("replays historical evidence without revalidation or repeating the transition", async () => {
  const first = await post();
  expect(first.status).toBe(200);
  db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  inspect.mockClear().mockResolvedValue(false);
  const replay = await post();
  expect(replay.status).toBe(200); expect(replay.body).toEqual(first.body);
  expect(evidence()).toHaveLength(1); expect(content().version).toBe(3); expect(inspect).not.toHaveBeenCalled();
});
it.each(["content", "image", "version", "actor"])("rejects mismatched request binding: %s", async (component) => {
  expect((await post()).status).toBe(200);
  const body = { ...input };
  let url = endpoint;
  if (component === "content") url = "/social/other/approve";
  if (component === "image") body.preparedImageId = "other";
  if (component === "version") body.expectedVersion = 3;
  if (component === "actor") {
    await createAdminUser(db, { email: "other@example.test", password: "safe-test-password-123", role: "owner" });
    const session = await login(db, { email: "other@example.test", password: "safe-test-password-123" });
    cookie = `noctella_admin_session=${session.rawToken}`;
  }
  expect((await post(body, url)).status).toBe(409); expect(evidence()).toHaveLength(1); expect(content().version).toBe(3);
});
it("authenticates and authorizes retries", async () => {
  expect((await post()).status).toBe(200);
  expect((await request(app).post(endpoint).send(input)).status).toBe(401);
  db.update(schema.adminUsers).set({ role: "product_editor" }).run();
  expect((await post()).status).toBe(403); expect(evidence()).toHaveLength(1);
});
it("handles identical concurrent requests as one approval", async () => {
  const responses = await Promise.all([post(), post()]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(responses[0].body).toEqual(responses[1].body);
  expect(evidence()).toHaveLength(1); expect(content().version).toBe(3);
});
it.each(["version", "source", "selection"])("guards the validation-to-write gap: %s", async (change) => {
  vi.mocked(preparation.createSocialContentPreparationService).mockImplementation((client) => {
    const service = originalFactory(client, "test-memory", render, inspect);
    return { ...service, async validatePreparedImageCurrent(...args) {
      const result = await service.validatePreparedImageCurrent(...args);
      if (change === "version") db.update(schema.socialContents).set({ version: 3 }).run();
      if (change === "source") db.update(schema.productPhotos).set({ url: "/images/product-photos/changed.webp" }).run();
      if (change === "selection") db.update(schema.socialContentMedia).set({ id: "replacement" }).run();
      return result;
    } };
  });
  expect((await post()).status).toBe(409); expect(evidence()).toEqual([]);
  expect(content().status).toBe("ready_for_review");
});
it.each(["transition", "insert"])("rolls back both sides on %s failure", async (failure) => {
  (db as any).$client.exec(failure === "transition"
    ? "CREATE TRIGGER fail_approval BEFORE UPDATE ON social_contents BEGIN SELECT RAISE(ABORT, 'forced failure'); END"
    : "CREATE TRIGGER fail_evidence BEFORE INSERT ON social_content_approvals BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  const response = await post();
  expect(response.status).toBe(500); expect(response.body).toEqual({ error: "Internal server error" });
  expect(evidence()).toEqual([]); expect(content()).toMatchObject({ status: "ready_for_review", version: 2 });
});
it("rolls back evidence for an invalid editorial transition", async () => {
  db.update(schema.socialContents).set({ status: "draft" }).run();
  expect((await post()).status).toBe(409); expect(evidence()).toEqual([]); expect(content().status).toBe("draft");
});
it("sanitizes inspection errors without evidence or transition", async () => {
  inspect.mockRejectedValue(new Error("private filesystem/provider detail"));
  const response = await post();
  expect(response.status).toBe(500); expect(response.body).toEqual({ error: "Internal server error" });
  expect(evidence()).toEqual([]); expect(content().status).toBe("ready_for_review");
});
