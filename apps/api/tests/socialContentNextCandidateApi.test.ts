import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentRouter } from "../src/routes/socialContent";
import * as selection from "../src/services/socialContentSelection";
import * as generation from "../src/services/socialContentGeneration";
import { createAdminUser, login } from "../src/services/adminAuth";

let db: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof express>;
let cookie: string;
const endpoint = "/api/social/contents/next-candidate";
const providerFactory = vi.fn(() => { throw new Error("Unexpected provider construction"); });
beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  db = createTestDb(); providerFactory.mockClear();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  vi.spyOn(generation, "generateSocialContent").mockRejectedValue(new Error("Unexpected generation"));
  vi.spyOn(selection, "selectNextSocialContentCandidate");
  app = express(); app.use(express.json()); app.use("/api/social/contents", createSocialContentRouter(db, providerFactory));
  await createAdminUser(db, { email: "editor@example.test", password: "safe-test-password-123", role: "product_editor" });
  const session = await login(db, { email: "editor@example.test", password: "safe-test-password-123" });
  cookie = `noctella_admin_session=${session.rawToken}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close(); });
async function product(id: string, categoryId: string, ready: boolean) {
  await db.insert(schema.categories).values({ id: categoryId, name: categoryId, slug: categoryId }).onConflictDoNothing();
  await db.insert(schema.products).values({ id, title: id, sku: id, slug: id, type: "unique_item", status: "draft", categoryId });
  await db.insert(schema.productPhotos).values({ id: `${id}-photo`, productId: id, processingStatus: ready ? "Ready" : "Processing", url: "/photo.webp", thumbnailUrl: "/thumb.webp", filename: "photo.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 100 });
}
async function snapshot() {
  return {
    products: await db.select().from(schema.products), photos: await db.select().from(schema.productPhotos),
    contents: await db.select().from(schema.socialContents), media: await db.select().from(schema.socialContentMedia),
    attempts: await db.select().from(schema.instagramPublishAttempts),
  };
}
function noGeneration() {
  expect(generation.generateSocialContent).not.toHaveBeenCalled();
  expect(providerFactory).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
}

it("requires authentication and products.edit before selection", async () => {
  expect((await request(app).get(endpoint).set("x-admin-role", "owner")).status).toBe(401);
  await createAdminUser(db, { email: "reviewer@example.test", password: "safe-test-password-123", role: "ai_reviewer" });
  const session = await login(db, { email: "reviewer@example.test", password: "safe-test-password-123" });
  expect((await request(app).get(endpoint).set("Cookie", `noctella_admin_session=${session.rawToken}`)).status).toBe(403);
  expect(selection.selectNextSocialContentCandidate).not.toHaveBeenCalled(); noGeneration();
});

it("returns the existing deterministic service result without mutating domain data", async () => {
  await product("history", "art", false); await product("a", "art", true);
  await product("b", "books", true); await product("blocked", "books", true);
  await db.insert(schema.socialContents).values([
    { id: "old", productId: "history", contentType: "post", status: "rejected" },
    { id: "active", productId: "blocked", contentType: "post", status: "draft" },
  ]);
  // History includes both classifications, so make b's category a non-recent alternative.
  await db.insert(schema.categories).values({ id: "ceramics", name: "ceramics", slug: "ceramics" });
  const { eq } = await import("drizzle-orm");
  await db.update(schema.products).set({ categoryId: "ceramics" }).where(eq(schema.products.id, "b"));
  const before = await snapshot();
  const expected = await selection.selectNextSocialContentCandidate(db);
  vi.mocked(selection.selectNextSocialContentCandidate).mockClear();
  const response = await request(app).get(endpoint).set("Cookie", cookie);
  expect(response.status).toBe(200); expect(response.body).toEqual(expected);
  expect(response.body).toEqual({ productId: "b", title: "b", classification: "category:ceramics", diversityPreferred: true,
    readyPhotoCount: 1, latestSocialActivityAt: null, latestSocialStatus: null, reason: "never_used" });
  expect(selection.selectNextSocialContentCandidate).toHaveBeenCalledWith(db);
  expect((await request(app).get(endpoint).set("Cookie", cookie)).body).toEqual(response.body);
  expect(await snapshot()).toEqual(before); noGeneration();
});

it("returns HTTP 200 with JSON null when no eligible candidate exists", async () => {
  await product("pending", "art", false);
  const before = await snapshot();
  const response = await request(app).get(endpoint).set("Cookie", cookie);
  expect(response.status).toBe(200); expect(response.body).toBeNull();
  expect(await snapshot()).toEqual(before); noGeneration();
});
