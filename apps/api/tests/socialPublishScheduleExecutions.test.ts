import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createSocialPublishScheduleExecutionService } from "../src/services/socialPublishScheduleExecutions";
import { createSocialPublishScheduleExecutionRepository } from "../src/repositories/social-content/publishScheduleExecutions";
import { loadInstagramCredential } from "../src/integrations/instagram/connection";
import { publishInstagramImage } from "../src/services/instagramPublishing";
import { enqueueJob } from "../src/services/backgroundJobs";

vi.mock("../src/integrations/instagram/connection", () => ({ loadInstagramCredential: vi.fn(() => { throw new Error("No credentials"); }) }));
vi.mock("../src/services/instagramPublishing", () => ({ publishInstagramImage: vi.fn(() => { throw new Error("No publishing"); }) }));
vi.mock("../src/services/backgroundJobs", () => ({ enqueueJob: vi.fn(() => { throw new Error("No jobs"); }) }));

let db: ReturnType<typeof createTestDb>;
const now = Date.parse("2030-10-05T12:00:00.000Z");
const rows = () => db.select().from(schema.socialPublishScheduleExecutions).all();
function seed(suffix = "") {
  db.insert(schema.socialContents).values({ id: `content${suffix}`, productId: "product", contentType: "post", caption: "Reviewed caption", status: "approved", version: 3 }).run();
  db.insert(schema.socialContentMedia).values({ id: `selection${suffix}`, contentId: `content${suffix}`, photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({ id: `prepared${suffix}`, contentId: `content${suffix}`, sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg" }).run();
  db.insert(schema.socialContentApprovals).values({ id: `approval${suffix}`, requestId: `approval-request${suffix}`, contentId: `content${suffix}`, preparedImageId: `prepared${suffix}`, contentVersion: 2, approvedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishIntents).values({ id: `intent${suffix}`, requestId: `intent-request${suffix}`, approvalId: `approval${suffix}`, requestedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishSchedules).values({ id: `schedule${suffix}`, requestId: `schedule-request${suffix}`, publishIntentId: `intent${suffix}`, requestedByAdminUserId: "human", requestedPublicationAt: new Date(now).toISOString() }).run();
}
function evidence() {
  return [schema.socialPublishSchedules, schema.socialPublishIntents, schema.socialContentApprovals,
    schema.socialContents, schema.socialContentMedia, schema.socialPreparedImages, schema.productPhotos,
    schema.backgroundJobs, schema.instagramPublishAttempts, schema.marketplaceConnections]
    .map((table) => db.select().from(table).all());
}
async function create(id = "schedule") {
  const before = evidence();
  try { return await createSocialPublishScheduleExecutionService(db, "test-memory", () => now).create(id); }
  finally { expect(evidence()).toEqual(before); }
}
beforeEach(() => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  db = createTestDb();
  db.insert(schema.adminUsers).values({ id: "human", email: "human@example.test", passwordHash: "test-only", role: "owner" }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  seed();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(loadInstagramCredential).not.toHaveBeenCalled();
  expect(publishInstagramImage).not.toHaveBeenCalled();
  expect(enqueueJob).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});

it("creates a due handoff with server-owned identity/time and no execution side effects", async () => {
  const row = await create();
  expect(row).toEqual({ id: expect.any(String), scheduleId: "schedule", backgroundJobId: null, instagramAttemptId: null, createdAt: expect.any(String) });
  expect(Number.isFinite(Date.parse(row.createdAt))).toBe(true);
  expect(rows()).toEqual([row]);
  expect(db.select().from(schema.backgroundJobs).all()).toEqual([]);
  expect(db.select().from(schema.instagramPublishAttempts).all()).toEqual([]);
});
it("replays the same valid schedule without a second handoff", async () => {
  const first = await create(); expect(await create()).toEqual(first); expect(rows()).toHaveLength(1);
});
it("concurrent creation resolves to one stable handoff", async () => {
  const results = await Promise.all([create(), create(), create()]);
  expect(results).toEqual([results[0], results[0], results[0]]); expect(rows()).toHaveLength(1);
});
it("keeps different schedules distinct and permits multiple null references", async () => {
  seed("2");
  const first = await create(); const second = await create("schedule2");
  expect(second.id).not.toBe(first.id); expect(second.scheduleId).toBe("schedule2"); expect(rows()).toHaveLength(2);
});
it("repository uniqueness collision returns no insert and resolves the existing schedule", async () => {
  const first = await create();
  const repository = createSocialPublishScheduleExecutionRepository(db, "test-memory");
  const found = await repository.transaction(function* (tx) {
    expect(yield* repository.insert(tx, "schedule")).toBeNull();
    return yield* repository.findByScheduleId(tx, "schedule");
  });
  expect(found).toEqual(first); expect(rows()).toHaveLength(1);
});
it("rejects a future schedule without changing its time", async () => {
  db.update(schema.socialPublishSchedules).set({ requestedPublicationAt: new Date(now + 1).toISOString() }).run();
  await expect(create()).rejects.toThrow("not due"); expect(rows()).toEqual([]);
});
it("accepts overdue schedules without introducing an expiry policy", async () => {
  db.update(schema.socialPublishSchedules).set({ requestedPublicationAt: new Date(now - 2 * 86400000).toISOString() }).run();
  expect((await create()).scheduleId).toBe("schedule");
});
it("rejects missing schedule", async () => {
  await expect(create("missing")).rejects.toThrow("not found"); expect(rows()).toEqual([]);
});
it.each(["intent", "approval", "content"])("rejects broken historical chain: missing %s", async (missing) => {
  // Model corrupted historical references only in this disposable fixture.
  const client = (db as any).$client;
  client.exec("PRAGMA foreign_keys=OFF");
  if (missing === "intent") db.update(schema.socialPublishSchedules).set({ publishIntentId: "missing" }).run();
  if (missing === "approval") db.update(schema.socialPublishIntents).set({ approvalId: "missing" }).run();
  if (missing === "content") db.update(schema.socialContentApprovals).set({ contentId: "missing" }).run();
  client.exec("PRAGMA foreign_keys=ON");
  await expect(create()).rejects.toThrow("not found"); expect(rows()).toEqual([]);
});
it.each(["version", "status", "prepared", "unselected", "not-ready", "wrong-product", "platform", "account"])("rejects invalid canonical state: %s", async (change) => {
  if (change === "version") db.update(schema.socialContents).set({ version: 4 }).run();
  if (change === "status") db.update(schema.socialContents).set({ status: "draft" }).run();
  if (change === "prepared") {
    db.insert(schema.socialContents).values({ id: "other", contentType: "post" }).run();
    db.update(schema.socialPreparedImages).set({ contentId: "other" }).run();
  }
  if (change === "unselected") db.delete(schema.socialContentMedia).run();
  if (change === "not-ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (change === "wrong-product") {
    db.insert(schema.products).values({ id: "other", sku: "other", title: "Other", slug: "other", type: "unique_item", status: "draft" }).run();
    db.update(schema.socialContents).set({ productId: "other" }).run();
  }
  if (change === "platform" || change === "account") {
    (db as any).$client.exec("PRAGMA ignore_check_constraints=ON");
    db.update(schema.socialContents).set(change === "platform" ? { platform: "other" } : { accountLabel: "atelier" }).run();
  }
  await expect(create()).rejects.toThrow(); expect(rows()).toEqual([]);
});
it("rechecks eligibility on replay without altering existing handoff evidence", async () => {
  const first = await create();
  db.update(schema.socialContents).set({ version: 4 }).run();
  await expect(create()).rejects.toThrow("Approved content changed"); expect(rows()).toEqual([first]);
});
it("enforces required, unique and restrictive schedule references", async () => {
  await create();
  expect(() => db.insert(schema.socialPublishScheduleExecutions).values({ id: "duplicate", scheduleId: "schedule" }).run()).toThrow(/UNIQUE/);
  expect(() => db.insert(schema.socialPublishScheduleExecutions).values({ id: "missing", scheduleId: "missing" }).run()).toThrow(/FOREIGN KEY/);
  expect(() => (db as any).$client.exec("INSERT INTO social_publish_schedule_executions(id) VALUES ('no-schedule')")).toThrow(/NOT NULL/);
  expect(() => db.delete(schema.socialPublishSchedules).where(eq(schema.socialPublishSchedules.id, "schedule")).run()).toThrow(/FOREIGN KEY/);
});
it.each(["job", "attempt"])("enforces non-null %s uniqueness and restrictive FK at schema level", (kind) => {
  seed("2");
  if (kind === "job") db.insert(schema.backgroundJobs).values({ id: "job", type: "fixture", status: "pending", payloadSnapshot: "{}", idempotencyKey: "fixture", runAfter: new Date(now).toISOString() }).run();
  else {
    db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", status: "connected" }).run();
    db.insert(schema.instagramPublishAttempts).values({ id: "attempt", connectionId: "connection", idempotencyKey: "fixture", caption: "Reviewed", mediaUrl: "https://api.example.test/image.jpg", status: "pending" }).run();
  }
  const reference = kind === "job" ? { backgroundJobId: "job" } : { instagramAttemptId: "attempt" };
  // Direct inserts test future schema constraints, not an attachment API.
  db.insert(schema.socialPublishScheduleExecutions).values({ id: "first", scheduleId: "schedule", ...reference }).run();
  expect(() => db.insert(schema.socialPublishScheduleExecutions).values({ id: "duplicate", scheduleId: "schedule2", ...reference }).run()).toThrow(/UNIQUE/);
  expect(() => db.insert(schema.socialPublishScheduleExecutions).values({ id: "missing", scheduleId: "schedule2", ...(kind === "job" ? { backgroundJobId: "missing" } : { instagramAttemptId: "missing" }) }).run()).toThrow(/FOREIGN KEY/);
  expect(() => kind === "job" ? db.delete(schema.backgroundJobs).run() : db.delete(schema.instagramPublishAttempts).run()).toThrow(/FOREIGN KEY/);
});
it("additive initialization preserves canonical data without backfill and is repeatable", async () => {
  const client = (db as any).$client;
  const before = evidence();
  client.exec("DROP TABLE social_publish_schedule_executions");
  ensureSchema(client); ensureSchema(client);
  expect(evidence()).toEqual(before); expect(rows()).toEqual([]);
  const row = await create(); ensureSchema(client);
  expect(rows()).toEqual([row]); expect(evidence()).toEqual(before);
});
