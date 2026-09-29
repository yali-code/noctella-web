import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentRouter } from "../src/routes/socialContent";
import * as preparation from "../src/services/socialContentPreparation";
import { createAdminUser, login } from "../src/services/adminAuth";

let db: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof express>;
let cookie: string;
const endpoint = "/api/social/contents/content/prepare-image";
const origin = "https://api.example.test";
const originalFactory = preparation.createSocialContentPreparationService;
const providerFactory = vi.fn(() => { throw new Error("Unexpected provider construction"); });
const render = vi.fn();
const post = (body: unknown = { photoId: "photo" }, url = endpoint) => request(app).post(url).set("Cookie", cookie).send(body);
beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("PUBLIC_API_ORIGIN", origin + "/");
  vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
  db = createTestDb(); providerFactory.mockClear(); render.mockReset();
  render.mockImplementation(async (_photo, publicOrigin, _env, _root, recipe) => ({
    url: `${publicOrigin}/private-extra`, sourceFingerprint: "a".repeat(64), recipeVersion: recipe,
    outputPath: `/images/product-photos/${recipe}-${"a".repeat(64)}.jpg`,
  }));
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) => originalFactory(client, "test-memory", render));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  app = express(); app.use(express.json()); app.use("/api/social/contents", createSocialContentRouter(db, providerFactory));
  await createAdminUser(db, { email: "editor@example.test", password: "safe-test-password-123", role: "product_editor" });
  const session = await login(db, { email: "editor@example.test", password: "safe-test-password-123" });
  cookie = `noctella_admin_session=${session.rawToken}`;
  await db.insert(schema.products).values({ id: "p", sku: "p", title: "p", slug: "p", type: "unique_item", status: "draft" });
  await db.insert(schema.productPhotos).values({ id: "photo", productId: "p", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 });
  await db.insert(schema.socialContents).values({ id: "content", productId: "p", contentType: "post", caption: "Human caption" });
  await db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 });
});
afterEach(async () => {
  expect(providerFactory).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(await db.select().from(schema.instagramPublishAttempts)).toEqual([]);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});

it("defaults to square, projects only durable fields and reuses independent square/portrait identities", async () => {
  const photos = await db.select().from(schema.productPhotos);
  const contents = await db.select().from(schema.socialContents);
  const first = await post();
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ id: expect.any(String), contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64),
    recipeVersion: "instagram-v1", outputPath: `/images/product-photos/instagram-v1-${"a".repeat(64)}.jpg` });
  const square = await post({ photoId: "photo", recipe: "instagram-v1" });
  expect(square.status).toBe(200); expect(square.body).toEqual(first.body);
  const portrait = await post({ photoId: "photo", recipe: "instagram-portrait-v1" });
  expect(portrait.status).toBe(200); expect(portrait.body.recipeVersion).toBe("instagram-portrait-v1");
  expect(portrait.body.id).not.toBe(first.body.id); expect(portrait.body.outputPath).not.toBe(first.body.outputPath);
  expect((await post({ photoId: "photo", recipe: "instagram-portrait-v1" })).body).toEqual(portrait.body);
  expect(await db.select().from(schema.socialPreparedImages)).toHaveLength(2);
  expect(await db.select().from(schema.productPhotos)).toEqual(photos);
  expect(await db.select().from(schema.socialContents)).toEqual(contents);
});
it.each([
  {}, { photoId: "bad/photo" }, { photoId: "photo", recipe: "invalid" }, { photoId: "photo", recipe: null },
  ...["width", "height", "dimensions", "url", "path", "publicOrigin"].map(key => ({ photoId: "photo", [key]: "untrusted" })),
])("rejects invalid body %j before preparation", async (body) => {
  expect((await post(body)).status).toBe(400); expect(render).not.toHaveBeenCalled();
});
it("rejects invalid content ID", async () => {
  expect((await post({ photoId: "photo" }, "/api/social/contents/bad%20id/prepare-image")).status).toBe(400);
  expect(render).not.toHaveBeenCalled();
});
it("returns 404 for missing content", async () => {
  expect((await post({ photoId: "photo" }, "/api/social/contents/missing/prepare-image")).status).toBe(404);
});
it.each(["unselected", "ownership", "not-ready"])("preserves 400 for %s source", async (condition) => {
  if (condition === "unselected") await db.delete(schema.socialContentMedia);
  if (condition === "not-ready") await db.update(schema.productPhotos).set({ processingStatus: "Processing" });
  if (condition === "ownership") {
    await db.insert(schema.products).values({ id: "other", sku: "other", title: "other", slug: "other", type: "unique_item", status: "draft" });
    await db.update(schema.socialContents).set({ productId: "other" });
  }
  expect((await post()).status).toBe(400); expect(render).not.toHaveBeenCalled();
});
it("preserves service conflict as 409 without persisting success", async () => {
  const implementation = render.getMockImplementation()!;
  render.mockImplementationOnce(async (...args) => {
    const asset = await implementation(...args);
    await db.update(schema.socialContents).set({ version: 2 });
    return asset;
  });
  expect((await post()).status).toBe(409);
  expect(await db.select().from(schema.socialPreparedImages)).toEqual([]);
});
it("requires session, products.edit and the existing origin check", async () => {
  expect((await request(app).post(endpoint).set("x-admin-role", "owner").send({ photoId: "photo" })).status).toBe(401);
  expect((await post().set("Origin", "https://evil.example.test")).status).toBe(403);
  await createAdminUser(db, { email: "reviewer@example.test", password: "safe-test-password-123", role: "ai_reviewer" });
  const session = await login(db, { email: "reviewer@example.test", password: "safe-test-password-123" });
  expect((await request(app).post(endpoint).set("Cookie", `noctella_admin_session=${session.rawToken}`).send({ photoId: "photo" })).status).toBe(403);
  expect(render).not.toHaveBeenCalled();
});
it.each([undefined, "http://api.example.test", "https://user:secret@api.example.test"])("sanitizes missing/invalid configured origin %j", async (value) => {
  vi.stubEnv("PUBLIC_API_ORIGIN", value);
  const response = await post().set("Host", "api.example.test").set("X-Forwarded-Host", "api.example.test").set("Origin", "https://admin.example.test");
  expect(response.status).toBe(500); expect(response.body).toEqual({ error: "Internal server error" });
  expect(render).not.toHaveBeenCalled();
});
it("ignores request host headers and uses only the canonical configured origin", async () => {
  expect((await post().set("Host", "untrusted.example.test").set("X-Forwarded-Host", "untrusted.example.test")).status).toBe(200);
  expect(render).toHaveBeenCalledWith({ url: "/images/product-photos/source.webp" }, origin, undefined, undefined, "instagram-v1");
});
it("sanitizes unexpected preparation failure without persisting success", async () => {
  render.mockRejectedValueOnce(new Error("C:/private/photo.webp token=secret"));
  const response = await post();
  expect(response.status).toBe(500); expect(response.body).toEqual({ error: "Internal server error" });
  expect(await db.select().from(schema.socialPreparedImages)).toEqual([]);
});
