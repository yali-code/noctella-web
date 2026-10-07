import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialPublishScheduleExecutionService } from "../src/services/socialPublishScheduleExecutions";
import { SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE } from "../src/repositories/social-content/publishScheduleExecutions";
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
    schema.instagramPublishAttempts, schema.marketplaceConnections]
    .map((table) => db.select().from(table).all());
}
async function create(id = "schedule") {
  const before = evidence();
  try { return await createSocialPublishScheduleExecutionService(db, "test-memory", () => now).enqueue(id); }
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


it("atomically creates one handoff and job with only the schedule identity", async () => {
  const execution = await create();
  const jobs = db.select().from(schema.backgroundJobs).all();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: execution.backgroundJobId, type: SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE, status: "pending", claimToken: null,
    idempotencyKey: `social-publish-schedule:${execution.id}`, payloadSnapshot: JSON.stringify({ scheduleId: "schedule" }) });
  expect(execution.instagramAttemptId).toBeNull();
  expect(rows()).toEqual([execution]);
});
it("attaches to an existing handoff and preserves its identity", async () => {
  const handoff = await createSocialPublishScheduleExecutionService(db, "test-memory", () => now).create("schedule");
  expect(await create()).toMatchObject({ ...handoff, backgroundJobId: expect.any(String) });
});
it("concurrent and repeated enqueue converge without duplicate jobs", async () => {
  const values = await Promise.all([create(), create(), create()]);
  expect(values).toEqual([values[0], values[0], values[0]]);
  expect(await create()).toEqual(values[0]);
  expect(rows()).toHaveLength(1);
  expect(db.select().from(schema.backgroundJobs).all()).toHaveLength(1);
});
it("keeps independent schedules and bindings distinct", async () => {
  seed("2");
  const a = await create(); const b = await create("schedule2");
  expect(a.backgroundJobId).not.toBe(b.backgroundJobId);
  expect(db.select().from(schema.backgroundJobs).all()).toHaveLength(2);
});
it.each(["cancelled", "succeeded", "failed", "processing"])("replay never resets a %s job", async status => {
  const first = await create();
  db.update(schema.backgroundJobs).set({ status, attemptCount: 2 }).run();
  const before = db.select().from(schema.backgroundJobs).all();
  expect(await create()).toEqual(first);
  expect(db.select().from(schema.backgroundJobs).all()).toEqual(before);
});
it.each(["wrong-type", "wrong-schedule", "extra-payload", "bad-json", "wrong-key", "product"])("rejects corrupted existing binding: %s", async change => {
  await create();
  if (change === "wrong-type") db.update(schema.backgroundJobs).set({ type: "other" }).run();
  if (change === "wrong-schedule") db.update(schema.backgroundJobs).set({ payloadSnapshot: '{"scheduleId":"other"}' }).run();
  if (change === "extra-payload") db.update(schema.backgroundJobs).set({ payloadSnapshot: '{"scheduleId":"schedule","caption":"unsafe"}' }).run();
  if (change === "bad-json") db.update(schema.backgroundJobs).set({ payloadSnapshot: "bad" }).run();
  if (change === "wrong-key") db.update(schema.backgroundJobs).set({ idempotencyKey: "other" }).run();
  if (change === "product") db.update(schema.backgroundJobs).set({ productId: "product" }).run();
  const before = db.select().from(schema.backgroundJobs).all();
  await expect(create()).rejects.toThrow("binding conflicted");
  expect(db.select().from(schema.backgroundJobs).all()).toEqual(before);
});
it.each([true, false])("rejects unbound idempotency collision, matching payload=%s", async matching => {
  const handoff = await createSocialPublishScheduleExecutionService(db, "test-memory", () => now).create("schedule");
  db.insert(schema.backgroundJobs).values({ id: "collision", type: matching ? SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE : "other", status: "pending",
    payloadSnapshot: JSON.stringify({ scheduleId: "schedule" }), idempotencyKey: `social-publish-schedule:${handoff.id}`, runAfter: new Date(now).toISOString() }).run();
  await expect(create()).rejects.toThrow("key conflicted");
  expect(rows()).toEqual([handoff]);
  expect(db.select().from(schema.backgroundJobs).all()).toHaveLength(1);
});
it("attachment failure rolls back the job and new handoff; retry succeeds", async () => {
  (db as any).$client.exec("CREATE TRIGGER fail_attachment BEFORE UPDATE OF background_job_id ON social_publish_schedule_executions BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
  await expect(create()).rejects.toThrow();
  expect(rows()).toEqual([]);
  expect(db.select().from(schema.backgroundJobs).all()).toEqual([]);
  (db as any).$client.exec("DROP TRIGGER fail_attachment");
  expect((await create()).backgroundJobId).not.toBeNull();
});
it.each(["future", "stale", "not-ready", "unselected", "missing"])("rejects ineligible schedule: %s", async change => {
  if (change === "future") db.update(schema.socialPublishSchedules).set({ requestedPublicationAt: new Date(now + 1).toISOString() }).run();
  if (change === "stale") db.update(schema.socialContents).set({ version: 4 }).run();
  if (change === "not-ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (change === "unselected") db.delete(schema.socialContentMedia).run();
  await expect(create(change === "missing" ? "missing" : "schedule")).rejects.toThrow();
  expect(rows()).toEqual([]);
  expect(db.select().from(schema.backgroundJobs).all()).toEqual([]);
});
it("revalidates canonical state before reusing a bound job", async () => {
  const first = await create();
  db.update(schema.socialContents).set({ version: 4 }).run();
  await expect(create()).rejects.toThrow("Approved content changed");
  expect(rows()).toEqual([first]);
  expect(db.select().from(schema.backgroundJobs).all()).toHaveLength(1);
});
