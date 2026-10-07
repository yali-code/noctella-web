// ETAP 7: the real scheduler endpoint discovers due social schedules BEFORE running due jobs, so a
// newly enqueued job is claimed by the normal claim-fenced runner in the same request. Env vars are
// read at import time, so they are set before src/app.ts is imported.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token";

beforeAll(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network")); });
afterAll(() => { vi.restoreAllMocks(); });

it("enqueues and executes a due schedule in the same scheduler request without provider side effects", async () => {
  const { default: app } = await import("../src/app");
  const { db } = await import("../src/db/client");
  const schema = await import("../src/db/schema");
  const run = () => request(app).post("/api/background-jobs/run").set("Authorization", "Bearer test-scheduler-token").send({});
  const now = Date.now();
  await db.insert(schema.adminUsers).values({ id: "human", email: "human@example.test", passwordHash: "test-only", role: "owner" });
  await db.insert(schema.products).values({ id: "product", sku: "SKU-SAME-RUN", title: "Product", slug: "same-run-product", type: "unique_item", status: "draft" } as any);
  await db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 } as any);
  for (const [suffix, at] of [["due", now - 60_000], ["future", now + 3_600_000]] as const) {
    await db.insert(schema.socialContents).values({ id: `content-${suffix}`, productId: "product", contentType: "post", caption: "Reviewed caption", status: "approved", version: 3 } as any);
    await db.insert(schema.socialContentMedia).values({ id: `selection-${suffix}`, contentId: `content-${suffix}`, photoId: "photo", sortOrder: 0 });
    await db.insert(schema.socialPreparedImages).values({ id: `prepared-${suffix}`, contentId: `content-${suffix}`, sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/missing.jpg" });
    await db.insert(schema.socialContentApprovals).values({ id: `approval-${suffix}`, requestId: `approval-request-${suffix}`, contentId: `content-${suffix}`, preparedImageId: `prepared-${suffix}`, contentVersion: 2, approvedByAdminUserId: "human" });
    await db.insert(schema.socialPublishIntents).values({ id: `intent-${suffix}`, requestId: `intent-request-${suffix}`, approvalId: `approval-${suffix}`, requestedByAdminUserId: "human" });
    await db.insert(schema.socialPublishSchedules).values({ id: `schedule-${suffix}`, requestId: `schedule-request-${suffix}`, publishIntentId: `intent-${suffix}`, requestedByAdminUserId: "human", requestedPublicationAt: new Date(at).toISOString() });
  }

  const first = await run();
  expect(first.status).toBe(200);
  expect(first.body.socialScheduleDiscovery).toEqual({ enqueued: 1, rejected: 0, failed: false });
  // The job discovered in this request was already claimed and executed by the normal runner.
  expect(first.body.processed).toBe(1);
  const [execution] = await db.select().from(schema.socialPublishScheduleExecutions);
  expect(execution.scheduleId).toBe("schedule-due");
  const [job] = await db.select().from(schema.backgroundJobs);
  expect(job.id).toBe(execution.backgroundJobId);
  // The prepared artifact file does not exist here, so canonical revalidation fails closed in the worker.
  expect(job).toMatchObject({ status: "failed", claimToken: null, lastError: "Validation: Social schedule execution validation failed" });

  const second = await run();
  expect(second.body.socialScheduleDiscovery).toEqual({ enqueued: 0, rejected: 0, failed: false });
  expect(second.body.processed).toBe(0);
  expect(await db.select().from(schema.socialPublishScheduleExecutions)).toHaveLength(1);
  expect(await db.select().from(schema.backgroundJobs)).toHaveLength(1);
  expect(await db.select().from(schema.instagramPublishAttempts)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
}, 20_000);
