import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { generateSocialContent } from "../src/services/socialContentGeneration";
import { createSocialContentService } from "../src/services/socialContent";
import { createSocialContentRouter } from "../src/routes/socialContent";
import { createAdminUser, login } from "../src/services/adminAuth";
import { createSocialGenerationProvider, type SocialGenerationContext } from "../src/social-content/provider";

let db: ReturnType<typeof createTestDb>;
const timestamp = "2026-09-24T10:00:00.000Z";
const input = () => ({ productId: "p1", contentType: "post", requestId: randomUUID() });
const output = () => ({ caption: "A collectible", hashtags: ["#Art"], concept: "Spotlight", media: [{ photoId: "photo1", editorialAltText: "Editorial description" }] });
const generate = vi.fn<(context: SocialGenerationContext) => Promise<unknown>>();
const factory = vi.fn(() => ({ provider: "fake", model: "test-model", promptVersion: "test-v1", generate }));
beforeEach(async () => {
  db = createTestDb();
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  generate.mockReset().mockResolvedValue(output()); factory.mockClear();
  for (const id of ["p1", "p2"]) await db.insert(schema.products).values({ id, sku: id, title: `Product ${id}`, description: "Stored details", slug: id, type: "unique_item", status: "draft", updatedAt: timestamp });
  for (const [id, productId, processingStatus] of [["photo1", "p1", "Ready"], ["pending", "p1", "Processing"], ["other", "p2", "Ready"]]) {
    await db.insert(schema.productPhotos).values({ id, productId, processingStatus, url: `/images/product-photos/${id}.webp`, thumbnailUrl: `/images/product-photos/${id}-thumb.webp`, filename: `${id}.webp`, mimeType: "image/webp", sizeBytes: 100, width: 200, height: 300, altText: "Canonical description" });
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close(); });

it("persists one draft from canonical context with trusted provenance and no canonical or publishing mutation", async () => {
  const products = await db.select().from(schema.products), photos = await db.select().from(schema.productPhotos);
  const req = input();
  const row = await generateSocialContent(db, req, factory);
  expect(generate).toHaveBeenCalledWith({ product: { id: "p1", sku: "p1", title: "Product p1", description: "Stored details", updatedAt: timestamp },
    photos: [{ id: "photo1", altText: "Canonical description", width: 200, height: 300 }], contentType: "post", platform: "instagram", accountLabel: "vault" });
  expect(row).toMatchObject({ status: "draft", platform: "instagram", accountLabel: "vault", aiProvider: "fake", aiModel: "test-model", aiPromptVersion: "test-v1", aiRequestId: req.requestId, aiSourceProductId: "p1", hashtags: ["art"] });
  expect(row.aiGeneratedAt).toBeTruthy();
  expect(row.media[0]).toMatchObject({ altText: "Canonical description", editorialAltText: "Editorial description" });
  expect(await db.select().from(schema.socialContents)).toHaveLength(1);
  expect(await db.select().from(schema.products)).toEqual(products);
  expect(await db.select().from(schema.productPhotos)).toEqual(photos);
  expect(await db.select().from(schema.instagramPublishAttempts)).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("replays current human edits/status without constructing or calling a provider", async () => {
  const req = input(), row = await generateSocialContent(db, req, factory);
  const service = createSocialContentService(db);
  const edited = await service.edit(row.id, { productId: "p1", contentType: "post", caption: "Human edit", mediaIds: ["photo1"], expectedVersion: 1 });
  const reviewed = await service.transition(row.id, { status: "ready_for_review", expectedVersion: edited.version });
  expect(await generateSocialContent(db, req, factory)).toEqual(reviewed);
  expect(factory).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
  await expect(generateSocialContent(db, { ...req, productId: "p2" }, factory)).rejects.toThrow("another source product");
});

it.each([null, {}, { ...output(), caption: "" }, { ...output(), aiProvider: "injected" },
  { ...output(), media: [{ photoId: "pending", editorialAltText: "Invalid" }] },
  { ...output(), media: [{ photoId: "other", editorialAltText: "Invalid" }] },
])("rejects malformed/unoffered provider output without a partial draft and permits retry: %j", async (value) => {
  const req = input(); generate.mockResolvedValueOnce(value);
  await expect(generateSocialContent(db, req, factory)).rejects.toThrow("unusable response");
  expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  expect(await db.select().from(schema.socialContentMedia)).toHaveLength(0);
  await expect(generateSocialContent(db, req, factory)).resolves.toMatchObject({ status: "draft" });
});

it("sanitizes provider exceptions and releases ownership for a retry", async () => {
  const req = input(); generate.mockRejectedValueOnce(new Error("fake-credential-do-not-expose"));
  await expect(generateSocialContent(db, req, factory)).rejects.toThrow("Social content generation is unavailable");
  expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  await expect(generateSocialContent(db, req, factory)).resolves.toMatchObject({ status: "draft" });
});

it("guards duplicate request and product before provider work", async () => {
  let finish!: (value: unknown) => void, started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  generate.mockImplementationOnce(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const req = input(), first = generateSocialContent(db, req, factory);
  await entered;
  try {
    await expect(generateSocialContent(db, req, factory)).rejects.toThrow("already in progress");
    await expect(generateSocialContent(db, input(), factory)).rejects.toThrow("already in progress");
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { finish(output()); await first; }
});

it.each(["stale", "not_ready", "ownership"])("revalidates %s after provider work before persistence", async (change) => {
  generate.mockImplementationOnce(async () => {
    if (change === "stale") await db.update(schema.products).set({ updatedAt: "2026-09-25T10:00:00.000Z" }).where(eq(schema.products.id, "p1"));
    else await db.update(schema.productPhotos).set(change === "not_ready" ? { processingStatus: "Processing" } : { productId: "p2" }).where(eq(schema.productPhotos.id, "photo1"));
    return output();
  });
  await expect(generateSocialContent(db, input(), factory)).rejects.toThrow();
  expect(await db.select().from(schema.socialContents)).toHaveLength(0);
});

it("fails before provider work when there is no product or ready media", async () => {
  await expect(generateSocialContent(db, { ...input(), productId: "missing" }, factory)).rejects.toThrow("does not exist");
  await db.update(schema.productPhotos).set({ processingStatus: "Processing" }).where(eq(schema.productPhotos.id, "photo1"));
  await expect(generateSocialContent(db, input(), factory)).rejects.toThrow("ready product photo");
  expect(factory).not.toHaveBeenCalled();
});

it("preserves route authentication, CSRF, validation and sanitizes provider errors", async () => {
  vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
  const app = express(); app.use(express.json()); app.use("/social", createSocialContentRouter(db, factory));
  expect((await request(app).post("/social/generate").send(input())).status).toBe(401);
  expect((await request(app).post("/social/generate").set("Origin", "https://evil.test").send(input())).status).toBe(403);
  await createAdminUser(db, { email: "editor@example.test", password: "safe-test-password-123", role: "product_editor" });
  const session = await login(db, { email: "editor@example.test", password: "safe-test-password-123" });
  const post = (value: unknown) => request(app).post("/social/generate").set("Cookie", `noctella_admin_session=${session.rawToken}`).send(value);
  expect((await post({ ...input(), accountLabel: "atelier" })).status).toBe(400);
  expect((await post({ ...input(), requestId: "bad" })).status).toBe(400);
  expect(generate).not.toHaveBeenCalled();
  generate.mockRejectedValueOnce(new Error("fake-credential-do-not-expose"));
  const failed = await post(input()); expect(failed.status).toBe(502);
  expect(failed.body.code).toBe("SOCIAL_GENERATION_PROVIDER_FAILED"); expect(JSON.stringify(failed.body)).not.toContain("fake-credential");
  const req = input(); const created = await post(req); expect(created.status).toBe(201);
  expect((await post(req)).body.id).toBe(created.body.id);
});

it("uses safe mock by default and rejects unsupported provider configuration", async () => {
  vi.stubEnv("SOCIAL_CONTENT_AI_PROVIDER", "");
  expect((await generateSocialContent(db, input())).aiProvider).toBe("mock");
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("SOCIAL_CONTENT_AI_PROVIDER", "invalid");
  expect(() => createSocialGenerationProvider()).toThrow("Social content generation is unavailable");
});

it("uses the shared structured transport with server-owned metadata (mocked fetch only)", async () => {
  vi.stubEnv("SOCIAL_CONTENT_AI_PROVIDER", "openai");
  vi.stubEnv("AI_INTAKE_OPENAI_API_KEY", "fake-test-key"); vi.stubEnv("AI_INTAKE_OPENAI_MODEL", "test-model");
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output()) }] }] }), { status: 200 }));
  const row = await generateSocialContent(db, input());
  expect(row).toMatchObject({ aiProvider: "openai", aiModel: "test-model", aiPromptVersion: "social-content-v1" });
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
  expect(body.input[0].content[0].text).not.toContain("fake-test-key");
});
