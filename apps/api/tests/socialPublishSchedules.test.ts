import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { createSocialContentRouter } from "../src/routes/socialContent";
import { createAdminUser, login } from "../src/services/adminAuth";
import { createSocialContentService } from "../src/services/socialContent";
import { createSocialPublishIntentService } from "../src/services/socialPublishIntents";
import { createSocialPublishScheduleService } from "../src/services/socialPublishSchedules";
import * as preparation from "../src/services/socialContentPreparation";
import * as publishing from "../src/services/instagramPublishing";
import * as jobs from "../src/services/backgroundJobs";

let db: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof express>;
let cookie: string;
let actorId: string;
let approvalId: string;
let requestId: string;
let publishIntentId: string;
const future = "2030-10-05T18:30:00.000Z";
const factory = preparation.createSocialContentPreparationService;
const inspect = vi.fn();
const render = vi.fn();
const path = "/api/social/contents/publish-schedules";
const body = () => ({ publishIntentId, requestId, requestedPublicationAt: future });
const post = (value: unknown = body()) => request(app).post(path).set("Cookie", cookie).send(value);
const rows = () => db.select().from(schema.socialPublishSchedules).all();

beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-10-05T12:00:00Z"));
  db = createTestDb(); requestId = randomUUID();
  inspect.mockReset().mockResolvedValue(true);
  render.mockReset().mockRejectedValue(new Error("Must not render"));
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) => factory(client, "test-memory", render, inspect));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  vi.spyOn(publishing, "publishInstagramImage").mockRejectedValue(new Error("Must not execute"));
  vi.spyOn(jobs, "enqueueJob").mockRejectedValue(new Error("Must not enqueue"));
  await createAdminUser(db, { email: "human@example.test", password: "safe-test-password-123", role: "owner" });
  actorId = db.select().from(schema.adminUsers).get()!.id;
  cookie = `noctella_admin_session=${(await login(db, { email: "human@example.test", password: "safe-test-password-123" })).rawToken}`;
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  db.insert(schema.socialContents).values({ id: "content", productId: "product", contentType: "post", caption: "Reviewed caption", status: "ready_for_review", version: 2 }).run();
  db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({ id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64),
    recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-approved.jpg" }).run();
  approvalId = (await createSocialContentService(db, "test-memory").approve("content", {
    preparedImageId: "prepared", expectedVersion: 2, requestId: randomUUID(),
  }, actorId)).id;
  publishIntentId = (await createSocialPublishIntentService(db, "test-memory").create({ approvalId, requestId: randomUUID() }, actorId)).id;
  app = express(); app.use(express.json()); app.use("/api/social/contents", createSocialContentRouter(db));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(publishing.publishInstagramImage).not.toHaveBeenCalled();
  expect(jobs.enqueueJob).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(db.select().from(schema.instagramPublishAttempts).all()).toEqual([]);
  expect(db.select().from(schema.backgroundJobs).all()).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});

it("requires session, publishing permission and trusted origin", async () => {
  expect((await request(app).post(path).send(body())).status).toBe(401);
  expect((await post().set("Origin", "https://evil.example.test")).status).toBe(403);
  db.update(schema.adminUsers).set({ role: "product_editor" }).run();
  expect((await post()).status).toBe(403); expect(rows()).toEqual([]);
});
it.each([{}, { publishIntentId: 5 }, { ...{ requestedPublicationAt: future }, requestId: "invalid" }])("rejects malformed body %j", async (value) => {
  expect((await post(value)).status).toBe(400); expect(rows()).toEqual([]);
});
it.each(["requestedByAdminUserId", "actorId", "runAfter", "status"])("rejects unknown field %s", async (key) => {
  expect((await post({ ...body(), [key]: "untrusted" })).status).toBe(400); expect(rows()).toEqual([]);
});
it("rejects nonexistent intent", async () => {
  expect((await post({ ...body(), publishIntentId: "absent" })).status).toBe(404); expect(rows()).toEqual([]);
});
it.each(["2030-10-05T18:30:00", "not-a-date", "2030-02-30T18:30:00Z", "2030-10-05T18:30:00+25:00", "2030-10-05T11:59:59Z", "2030-10-05T12:00:00Z"])("rejects invalid/nonfuture time %s", async (requestedPublicationAt) => {
  expect((await post({ ...body(), requestedPublicationAt })).status).toBe(400); expect(rows()).toEqual([]);
});
it.each(["version", "status", "artifact", "wrong-content", "not-ready", "unselected", "platform", "account"])("rejects stale canonical state: %s", async (change) => {
  if (change === "version") db.update(schema.socialContents).set({ version: 4 }).run();
  if (change === "status") db.update(schema.socialContents).set({ status: "draft" }).run();
  if (change === "artifact") inspect.mockResolvedValue(false);
  if (change === "not-ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (change === "unselected") db.delete(schema.socialContentMedia).run();
  if (change === "wrong-content") {
    db.insert(schema.socialContents).values({ id: "other", contentType: "post" }).run();
    db.update(schema.socialPreparedImages).set({ contentId: "other" }).run();
  }
  if (change === "platform" || change === "account") {
    (db as any).$client.exec("PRAGMA ignore_check_constraints=ON");
    db.update(schema.socialContents).set(change === "platform" ? { platform: "other" } : { accountLabel: "atelier" }).run();
  }
  expect([400, 404, 409]).toContain((await post()).status); expect(rows()).toEqual([]);
});
it.each(["2030-10-05T18:30:00Z", "2030-10-05T21:30:00+03:00"])("persists canonical UTC and replays equivalent instant: %s", async (requestedPublicationAt) => {
  const intent = db.select().from(schema.socialPublishIntents).get();
  const approval = db.select().from(schema.socialContentApprovals).get();
  const first = await post({ ...body(), requestedPublicationAt });
  expect(first.status).toBe(201);
  expect(first.body).toEqual({ id: expect.any(String), requestId, publishIntentId, requestedPublicationAt: future, requestedByAdminUserId: actorId, createdAt: expect.any(String) });
  expect(rows()[0]).toEqual(first.body);
  expect((await post()).body).toEqual(first.body); expect(rows()).toHaveLength(1);
  expect(db.select().from(schema.socialPublishIntents).get()).toEqual(intent);
  expect(db.select().from(schema.socialContentApprovals).get()).toEqual(approval);
  expect(db.select().from(schema.marketplaceConnections).all()).toEqual([]);
});
it("historical replay survives due time and invalid artifact but rechecks authorization", async () => {
  const first = await post(); expect(first.status).toBe(201);
  vi.setSystemTime(new Date("2030-10-05T19:00:00Z")); inspect.mockResolvedValue(false);
  cookie = `noctella_admin_session=${(await login(db, { email: "human@example.test", password: "safe-test-password-123" })).rawToken}`;
  expect((await post()).body).toEqual(first.body);
  db.update(schema.adminUsers).set({ role: "product_editor" }).run();
  expect((await post()).status).toBe(403);
});
it("rejects intent, time and second-request collisions", async () => {
  expect((await post()).status).toBe(201);
  expect((await post({ ...body(), publishIntentId: "different" })).status).toBe(409);
  expect((await post({ ...body(), requestedPublicationAt: "2030-10-06T18:30:00Z" })).status).toBe(409);
  expect((await post({ ...body(), requestId: randomUUID() })).status).toBe(409);
  expect(rows()).toHaveLength(1);
});
it("allows a distinct requesting Admin but rejects actor collisions", async () => {
  await createAdminUser(db, { email: "scheduler@example.test", password: "safe-test-password-123", role: "owner" });
  const originalCookie = cookie;
  cookie = `noctella_admin_session=${(await login(db, { email: "scheduler@example.test", password: "safe-test-password-123" })).rawToken}`;
  const first = await post(); expect(first.status).toBe(201);
  expect(first.body.requestedByAdminUserId).not.toBe(actorId);
  cookie = originalCookie;
  expect((await post()).status).toBe(409);
});
it.each([false, true])("concurrent creation preserves uniqueness (different request: %s)", async (different) => {
  const results = await Promise.all([post(), post({ ...body(), requestId: different ? randomUUID() : requestId })]);
  expect(results.map((r) => r.status).sort()).toEqual(different ? [201, 409] : [201, 201]);
  expect(rows()).toHaveLength(1);
  if (!different) expect(results[0].body).toEqual(results[1].body);
});
it.each(["source", "time"])("rechecks %s after artifact inspection", async (change) => {
  vi.mocked(preparation.createSocialContentPreparationService).mockImplementation((client) => {
    const service = factory(client, "test-memory", render, inspect);
    return { ...service, async validatePreparedImageCurrent(...args) {
      const result = await service.validatePreparedImageCurrent(...args);
      if (change === "source") db.update(schema.productPhotos).set({ url: "/images/product-photos/changed.webp" }).run();
      else vi.setSystemTime(new Date(future));
      return result;
    } };
  });
  expect((await post()).status).toBe(change === "source" ? 409 : 400); expect(rows()).toEqual([]);
});
it("uses the injected clock without an arbitrary lead time", async () => {
  const service = createSocialPublishScheduleService(db, "test-memory", () => Date.parse(future) - 1);
  expect(await service.create(body(), actorId)).toMatchObject({ requestedPublicationAt: future });
});
it("additive SQLite upgrade preserves intent and enforces unique/restrictive references", async () => {
  const sqlite = (db as any).$client;
  const intent = db.select().from(schema.socialPublishIntents).get();
  sqlite.exec("DROP TABLE social_publish_schedules"); // Isolated pre-upgrade fixture.
  ensureSchema(sqlite); ensureSchema(sqlite);
  expect(rows()).toEqual([]); expect(db.select().from(schema.socialPublishIntents).get()).toEqual(intent);
  expect((await post()).status).toBe(201);
  const row = rows()[0];
  expect(() => db.insert(schema.socialPublishSchedules).values({ ...row, id: randomUUID(), requestId: randomUUID() }).run()).toThrow();
  expect(() => db.insert(schema.socialPublishSchedules).values({ ...row, id: randomUUID(), publishIntentId: "absent" }).run()).toThrow();
  expect(() => db.insert(schema.socialPublishSchedules).values({ ...row, id: randomUUID(), requestId: randomUUID(), publishIntentId: "absent" }).run()).toThrow();
  expect(() => db.delete(schema.socialPublishIntents).where(eq(schema.socialPublishIntents.id, publishIntentId)).run()).toThrow();
  // Use a separate Admin to ensure the schedule itself restricts deletion.
  db.insert(schema.adminUsers).values({ id: "requester", email: "fk@example.test", passwordHash: "test-only", role: "owner" }).run();
  db.update(schema.socialPublishSchedules).set({ requestedByAdminUserId: "requester" }).run();
  expect(() => db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, "requester")).run()).toThrow();
  expect(() => db.update(schema.socialPublishSchedules).set({ requestedByAdminUserId: "absent" }).run()).toThrow();
});
