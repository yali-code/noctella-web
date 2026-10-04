import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentService } from "../src/services/socialContent";
import { createSocialContentRepository } from "../src/repositories/social-content/drizzle";
import { createGeneratedSocialDraftUseCase, type GeneratedSocialDraftInput } from "../src/use-cases/social-content/useCases";
import { acquireSocialGenerationGuard } from "../src/use-cases/social-content/generationGuard";
import { createSocialContentRouter } from "../src/routes/socialContent";
import * as preparation from "../src/services/socialContentPreparation";
import { createAdminUser, login } from "../src/services/adminAuth";

let db: ReturnType<typeof createTestDb>;
let service: ReturnType<typeof createSocialContentService>;
const timestamp = "2026-09-24T10:00:00.000Z";
const manual = { contentType: "post", productId: "p1", caption: "A collectible", mediaIds: ["photo1", "photo2"] };
const generated = (overrides: Partial<GeneratedSocialDraftInput> = {}): GeneratedSocialDraftInput => ({
  productId: "p1", requestId: randomUUID(), contentType: "post", caption: "A collectible",
  hashtags: [" #Collectibles ", "collectibles", "Cafe\u0301"], concept: "Highlight the craftsmanship",
  media: [{ photoId: "photo1", editorialAltText: "Editorial description" }],
  aiProvider: "mock", aiModel: "deterministic", aiPromptVersion: "social-v1", aiGeneratedAt: timestamp,
  sourceProductUpdatedAt: timestamp, ...overrides,
});
beforeEach(async () => {
  db = createTestDb(); service = createSocialContentService(db, "test-memory");
  for (const id of ["p1", "p2"]) await db.insert(schema.products).values({ id, sku: id, title: id, slug: id, type: "unique_item", status: "draft", updatedAt: timestamp });
  for (const [id, productId] of [["photo1", "p1"], ["photo2", "p1"], ["other", "p2"]]) await db.insert(schema.productPhotos).values({
    id, productId, url: `/images/product-photos/${id}.webp`, thumbnailUrl: `/images/product-photos/${id}-thumb.webp`,
    filename: `${id}.webp`, mimeType: "image/webp", sizeBytes: 100, width: 200, height: 200, altText: "Canonical description",
  });
});
afterEach(() => { vi.restoreAllMocks(); (db as any).$client.close(); });

describe("Social editorial fields", () => {
  it("keeps old manual requests valid with nullable metadata", async () => {
    const row = await service.create(manual);
    expect(row).toMatchObject({ hashtags: null, concept: null, aiProvider: null, aiModel: null, aiPromptVersion: null, aiGeneratedAt: null, aiRequestId: null, aiSourceProductId: null });
    expect(row.media[0]).toMatchObject({ altText: "Canonical description", editorialAltText: null });
    await service.create(manual); // Multiple NULL request IDs are valid.
  });
  it("normalizes hashtags and persists content-specific alt text without changing canonical photos", async () => {
    const before = await db.select().from(schema.productPhotos);
    const row = await service.create({ ...manual, hashtags: [" #Art ", "ART", "Cafe\u0301", "café", "美術_2"], concept: "Concept", mediaEditorialAltTexts: [{ photoId: "photo1", editorialAltText: "Social alt" }] });
    expect(row.hashtags).toEqual(["art", "café", "美術_2"]);
    expect((await db.select().from(schema.socialContents))[0].hashtags).toBe('["art","café","美術_2"]');
    expect(row.media[0]).toMatchObject({ altText: "Canonical description", editorialAltText: "Social alt" });
    expect(await db.select().from(schema.productPhotos)).toEqual(before);
  });
  it.each([[""], ["##bad"], ["two words"], ["a-b"], ["a".repeat(51)], Array(11).fill("tag")].map((hashtags) => ({ hashtags })))("rejects invalid hashtags %j", async ({ hashtags }) => {
    await expect(service.create({ ...manual, hashtags })).rejects.toThrow();
  });
  it.each([
    { concept: "x".repeat(1001) },
    { mediaEditorialAltTexts: [{ photoId: "photo1", editorialAltText: "x".repeat(1001) }] },
    { mediaEditorialAltTexts: [{ photoId: "photo1", editorialAltText: "a" }, { photoId: "photo1", editorialAltText: "b" }] },
    { mediaEditorialAltTexts: [{ photoId: "other", editorialAltText: "a" }] },
  ])("rejects invalid editorial fields on both create and edit", async (invalid) => {
    const row = await service.create(manual);
    await expect(service.create({ ...manual, ...invalid })).rejects.toThrow();
    await expect(service.edit(row.id, { ...manual, ...invalid, expectedVersion: row.version })).rejects.toThrow();
    expect(await service.get(row.id)).toEqual(row);
  });
  it.each(["aiProvider", "aiModel", "aiPromptVersion", "aiGeneratedAt", "aiRequestId", "aiSourceProductId", "status"])("rejects mass assignment of %s", async (key) => {
    const row = await service.create(manual);
    await expect(service.create({ ...manual, [key]: "injected" })).rejects.toThrow();
    await expect(service.edit(row.id, { ...manual, [key]: "injected", expectedVersion: 1 })).rejects.toThrow();
  });
  it("preserves omitted editorial fields, updates explicitly, and removes alt text with removed media", async () => {
    let row = await service.create({ ...manual, hashtags: ["art"], concept: "Concept", mediaEditorialAltTexts: [{ photoId: "photo1", editorialAltText: "First" }, { photoId: "photo2", editorialAltText: "Second" }] });
    row = await service.edit(row.id, { ...manual, mediaIds: ["photo2"], expectedVersion: row.version });
    expect(row).toMatchObject({ hashtags: ["art"], concept: "Concept", media: [{ id: "photo2", editorialAltText: "Second" }] });
    expect(await db.select().from(schema.socialContentMedia)).toHaveLength(1);
    row = await service.edit(row.id, { ...manual, hashtags: [], concept: null, mediaEditorialAltTexts: [{ photoId: "photo2", editorialAltText: "" }], expectedVersion: row.version });
    expect(row).toMatchObject({ hashtags: [], concept: null });
    expect(row.media.map((photo) => photo.editorialAltText)).toEqual([null, ""]);
  });
});

describe("Internal generated-draft persistence", () => {
  it("creates only a Vault/Instagram draft and never writes canonical data or publication work", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
    const beforeProducts = await db.select().from(schema.products);
    const beforePhotos = await db.select().from(schema.productPhotos);
    const input = generated();
    const row = await service.createGenerated(input);
    expect(row).toMatchObject({ platform: "instagram", accountLabel: "vault", status: "draft", version: 1, hashtags: ["collectibles", "café"], aiRequestId: input.requestId, aiSourceProductId: "p1", aiProvider: "mock", aiModel: "deterministic", aiGeneratedAt: timestamp });
    expect(row.media[0].editorialAltText).toBe("Editorial description");
    expect(await db.select().from(schema.products)).toEqual(beforeProducts);
    expect(await db.select().from(schema.productPhotos)).toEqual(beforePhotos);
    expect(await db.select().from(schema.instagramPublishAttempts)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    { platform: "instagram" }, { accountLabel: "vault" }, { status: "approved" },
    { caption: " " }, { caption: "x".repeat(2201) }, { contentType: "video" },
    { requestId: "bad" }, { aiProvider: "x".repeat(129) }, { aiModel: "" }, { aiPromptVersion: "x".repeat(129) }, { aiGeneratedAt: "invalid" },
    { concept: "x".repeat(1001) }, { hashtags: ["bad tag"] }, { media: [] },
    { media: [{ photoId: "photo1", editorialAltText: "x".repeat(1001) }] },
    { media: Array(11).fill({ photoId: "photo1", editorialAltText: "a" }) },
    { media: Array(2).fill({ photoId: "photo1", editorialAltText: "a" }) },
  ])("rejects invalid generated input before persistence", async (invalid) => {
    await expect(service.createGenerated({ ...generated(), ...invalid } as any)).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  });
  it.each(["missing", "other"])("rejects missing or foreign-product media %s", async (photoId) => {
    await expect(service.createGenerated(generated({ media: [{ photoId, editorialAltText: "a" }] }))).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  });
  it("rejects non-Ready media and missing Product", async () => {
    await db.update(schema.productPhotos).set({ processingStatus: "Processing" }).where(eq(schema.productPhotos.id, "photo1"));
    await expect(service.createGenerated(generated())).rejects.toThrow("must be ready");
    await expect(service.createGenerated(generated({ productId: "missing" }))).rejects.toThrow("does not exist");
  });
  it("rejects a stale source before insertion and allows a retry with the current snapshot", async () => {
    const input = generated();
    await db.update(schema.products).set({ updatedAt: "2026-09-24T10:00:01.000Z" }).where(eq(schema.products.id, "p1"));
    await expect(service.createGenerated(input)).rejects.toThrow("Product changed");
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
    expect(await db.select().from(schema.socialContentMedia)).toHaveLength(0);
    expect((await service.createGenerated({ ...input, sourceProductUpdatedAt: "2026-09-24T10:00:01.000Z" })).status).toBe("draft");
  });
  it("replays the current human-approved record without reverting state or version", async () => {
    const input = generated();
    let row = await service.createGenerated(input);
    row = await service.edit(row.id, { ...manual, caption: "Human edit", expectedVersion: row.version });
    row = await service.transition(row.id, { status: "ready_for_review", expectedVersion: row.version });
    const originalFactory = preparation.createSocialContentPreparationService;
    const render = vi.fn(() => { throw new Error("Approval must not render"); });
    vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) =>
      originalFactory(client, "test-memory", render, vi.fn().mockResolvedValue(true)));
    await db.insert(schema.socialPreparedImages).values({
      id: "prepared", contentId: row.id, sourcePhotoId: "photo1", sourceFingerprint: "a".repeat(64),
      recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-test.jpg",
    });
    await createAdminUser(db, { email: "approver@example.test", password: "safe-test-password-123", role: "owner" });
    const session = await login(db, { email: "approver@example.test", password: "safe-test-password-123" });
    const app = express(); app.use(express.json()); app.use("/social", createSocialContentRouter(db));
    const approved = await request(app).post(`/social/${row.id}/approve`)
      .set("Cookie", `noctella_admin_session=${session.rawToken}`)
      .send({ preparedImageId: "prepared", expectedVersion: row.version, requestId: randomUUID() });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ contentId: row.id, preparedImageId: "prepared", contentVersion: row.version });
    const reviewedVersion = row.version;
    row = await service.get(row.id);
    expect(row).toMatchObject({ status: "approved", version: reviewedVersion + 1, caption: "Human edit" });
    expect(render).not.toHaveBeenCalled();
    expect(await service.createGenerated(input)).toEqual(row);
    expect(await db.select().from(schema.socialContents)).toHaveLength(1);
    expect(await db.select().from(schema.instagramPublishAttempts)).toHaveLength(0);
  });
  it("uses immutable source provenance after a human changes the selected Product", async () => {
    const input = generated();
    let row = await service.createGenerated(input);
    row = await service.edit(row.id, { ...manual, productId: "p2", mediaIds: ["other"], expectedVersion: row.version });
    expect(row.aiSourceProductId).toBe("p1");
    expect(await service.createGenerated(input)).toEqual(row);
    await expect(service.createGenerated({ ...input, productId: "p2" })).rejects.toThrow("another source product");
  });
  it("preserves provenance and idempotency when the canonical Product is deleted", async () => {
    const input = generated(); const row = await service.createGenerated(input);
    // Respect the existing canonical ProductPhoto -> Product FK before deleting Product.
    await db.delete(schema.productPhotos).where(eq(schema.productPhotos.productId, "p1"));
    await db.delete(schema.products).where(eq(schema.products.id, "p1"));
    expect(await service.createGenerated(input)).toMatchObject({ id: row.id, productId: null, aiSourceProductId: "p1" });
  });
  it("rolls back a failed media insert and leaves the request ID retryable", async () => {
    const input = generated(); const client = (db as any).$client;
    client.exec("CREATE TRIGGER fail_generated_media BEFORE INSERT ON social_content_media BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(service.createGenerated(input)).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
    expect(await db.select().from(schema.socialContentMedia)).toHaveLength(0);
    client.exec("DROP TRIGGER fail_generated_media");
    expect((await service.createGenerated(input)).aiRequestId).toBe(input.requestId);
  });
  it("enforces global uniqueness in the database", async () => {
    const row = await service.createGenerated(generated());
    await expect(db.insert(schema.socialContents).values({ id: randomUUID(), contentType: "post", aiRequestId: row.aiRequestId })).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(1);
  });
  it("recovers a competing unique-index winner after rollback", async () => {
    const input = generated(); const row = await service.createGenerated(input);
    const repository = createSocialContentRepository(db, "test-memory");
    let calls = 0;
    const lookup = repository.findByRequest;
    repository.findByRequest = function* (tx, requestId) { if (++calls <= 2) return null; return yield* lookup(tx, requestId); };
    expect(await createGeneratedSocialDraftUseCase(repository, input)).toEqual(row);
    expect(await db.select().from(schema.socialContentMedia)).toHaveLength(1);
    expect(await db.select().from(schema.socialContents)).toHaveLength(1);
  });
  it("guards both request and product identities and releases ownership safely", async () => {
    const input = generated(); const release = acquireSocialGenerationGuard(input.requestId, input.productId);
    try {
      await expect(service.createGenerated(input)).rejects.toThrow("already in progress");
      expect(() => acquireSocialGenerationGuard(input.requestId, "p2")).toThrow("already in progress");
      expect(() => acquireSocialGenerationGuard(randomUUID(), "p1")).toThrow("already in progress");
    } finally { release(); }
    const nextRelease = acquireSocialGenerationGuard(input.requestId, input.productId);
    release(); // Old release cannot clear the new owner's guard.
    expect(() => acquireSocialGenerationGuard(input.requestId, input.productId)).toThrow("already in progress");
    nextRelease();
    expect((await service.createGenerated(input)).status).toBe("draft");
  });
  it("recognizes only the request-ID uniqueness conflict, including wrapped PostgreSQL errors", () => {
    const repository = createSocialContentRepository(db, "test-memory");
    expect(repository.isRequestConflict({ cause: { code: "23505", constraint: "idx_social_contents_ai_request_unique" } })).toBe(true);
    expect(repository.isRequestConflict({ code: "23505", constraint: "some_other_index" })).toBe(false);
    expect(repository.isRequestConflict({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: social_contents.id" })).toBe(false);
  });
});
