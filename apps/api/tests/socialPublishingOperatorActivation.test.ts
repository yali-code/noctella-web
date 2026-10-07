import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { INSTAGRAM_VAULT_ACCOUNT_ID } from "../src/integrations/instagram/types";
import { encryptCredential } from "../src/services/credentialEncryption";
import { createSocialPublishScheduleExecutionService } from "../src/services/socialPublishScheduleExecutions";
import { createSocialPublishingChainService, requiresManualReconciliation } from "../src/services/socialPublishingChain";
import { getInstagramPublishingReadiness } from "../src/services/instagramPublishingReadiness";
import { createSocialContentRouter } from "../src/routes/socialContent";
import { createInstagramRouter } from "../src/routes/instagram";

let db: ReturnType<typeof createTestDb>;
const now = Date.parse("2030-10-05T12:00:00.000Z");
const env = { DATABASE_DRIVER: "test-memory", PUBLIC_API_ORIGIN: "https://api.example.test", INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test",
  INSTAGRAM_API_VERSION: "v24.0" };
const chain = () => createSocialPublishingChainService(db, "test-memory").get("content");
const evidence = () => [schema.socialContents, schema.socialPreparedImages, schema.socialContentApprovals, schema.socialPublishIntents,
  schema.socialPublishSchedules, schema.socialPublishScheduleExecutions, schema.backgroundJobs, schema.instagramPublishAttempts,
  schema.marketplaceConnections].map((table) => db.select().from(table).all());

beforeEach(() => {
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  db = createTestDb();
  db.insert(schema.adminUsers).values({ id: "human", email: "human@example.test", passwordHash: "test-only", role: "owner" }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  db.insert(schema.socialContents).values({ id: "content", productId: "product", contentType: "post", caption: "Private reviewed caption", status: "approved", version: 3 }).run();
  db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({ id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg" }).run();
  db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, status: "connected", encryptedAccessToken: encryptCredential("secret-token-value") }).run();
});
afterEach(() => {
  // Read paths never reach the provider.
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});
function approveAndSchedule() {
  db.insert(schema.socialContentApprovals).values({ id: "approval", requestId: "approval-request", contentId: "content", preparedImageId: "prepared", contentVersion: 2, approvedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishIntents).values({ id: "intent", requestId: "intent-request", approvalId: "approval", requestedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishSchedules).values({ id: "schedule", requestId: "schedule-request", publishIntentId: "intent", requestedByAdminUserId: "human", requestedPublicationAt: new Date(now).toISOString() }).run();
}

it("returns only the content and prepared image before approval", async () => {
  expect(await chain()).toEqual({
    content: { id: "content", status: "approved", version: 3, platform: "instagram", accountLabel: "vault" },
    preparedImages: [{ id: "prepared", sourcePhotoId: "photo", recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg" }],
    approvals: [],
  });
  await expect(createSocialPublishingChainService(db, "test-memory").get("missing")).rejects.toThrow("Social content not found");
});
it("returns the full sanitized chain and causes no state change", async () => {
  approveAndSchedule();
  const execution = await createSocialPublishScheduleExecutionService(db, "test-memory", () => now).enqueue("schedule");
  db.update(schema.backgroundJobs).set({ status: "processing", claimToken: "secret-claim-token", lockedBy: "worker" }).run();
  db.insert(schema.instagramPublishAttempts).values({ id: "igp_attempt", approvalId: "approval", connectionId: "connection", idempotencyKey: `social-publish-execution:${execution.id}`,
    caption: "Private reviewed caption", mediaUrl: "https://api.example.test/images/private.jpg", status: "reconciliation_required", providerEntryState: "claimed",
    containerId: "remote-container", lastError: "provider" }).run();
  db.update(schema.socialPublishScheduleExecutions).set({ instagramAttemptId: "igp_attempt" }).run();
  const before = evidence();
  const result = await chain();
  expect(await chain()).toEqual(result);
  expect(evidence()).toEqual(before);
  expect(result.approvals).toEqual([{
    id: "approval", preparedImageId: "prepared", contentVersion: 2, approvedAt: expect.any(String), current: true,
    intent: { id: "intent", createdAt: expect.any(String) },
    schedule: { id: "schedule", requestedPublicationAt: new Date(now).toISOString(), createdAt: expect.any(String) },
    execution: { id: execution.id, createdAt: expect.any(String) },
    job: { id: execution.backgroundJobId, status: "processing", attemptCount: 0, maxAttempts: expect.any(Number), lastError: null,
      runAfter: expect.any(String), completedAt: null, updatedAt: expect.any(String) },
    attempt: { id: "igp_attempt", origin: "scheduled", status: "reconciliation_required", providerEntryState: "claimed", hasContainer: true,
      lastError: "provider", publishedAt: null, updatedAt: expect.any(String), requiresManualReconciliation: true },
  }]);
  const body = JSON.stringify(result);
  for (const secret of ["secret-claim-token", "worker", "Private reviewed caption", "private.jpg", "remote-container", "scheduleId", "social-publish-execution"]) {
    expect(body).not.toContain(secret);
  }
});
it("marks a stale approval as not current", async () => {
  approveAndSchedule();
  db.update(schema.socialContents).set({ version: 4 }).run();
  expect((await chain()).approvals[0]).toMatchObject({ current: false, execution: null, job: null, attempt: null });
});
it.each([
  [{ status: "pending", providerEntryState: "unclaimed", containerId: null }, false],
  [{ status: "pending", providerEntryState: "claimed", containerId: null }, true],
  [{ status: "container_created", providerEntryState: "claimed", containerId: "111" }, false],
  [{ status: "publishing", providerEntryState: "claimed", containerId: "111" }, true],
  [{ status: "reconciliation_required", providerEntryState: "claimed", containerId: "111" }, true],
  [{ status: "pending", providerEntryState: null, containerId: null }, true],
  [{ status: "published", providerEntryState: "claimed", containerId: "111" }, false],
  [{ status: "failed", providerEntryState: "claimed", containerId: null }, false],
])("classifies manual reconciliation for %o", (attempt, expected) => {
  expect(requiresManualReconciliation(attempt)).toBe(expected);
});
it("reports missing configuration by name only and is not ready", async () => {
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", "");
  expect(await getInstagramPublishingReadiness(db, { DATABASE_DRIVER: "test-memory" })).toEqual({
    ready: false, mediaOriginAllowed: false, connection: "connected",
    checks: { INSTAGRAM_API_VERSION: "missing", INSTAGRAM_MEDIA_ALLOWED_HOSTS: "missing", PUBLIC_API_ORIGIN: "missing",
      INSTAGRAM_ALLOWED_ACCOUNT_IDS: "default", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: "missing" },
    missingConfiguration: ["INSTAGRAM_API_VERSION", "INSTAGRAM_MEDIA_ALLOWED_HOSTS", "PUBLIC_API_ORIGIN", "MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY"],
  });
});
it("reports ready with complete configuration and never returns values", async () => {
  const result = await getInstagramPublishingReadiness(db, env);
  expect(result).toMatchObject({ ready: true, mediaOriginAllowed: true, connection: "connected", missingConfiguration: [] });
  const body = JSON.stringify(result);
  for (const value of ["v24.0", "api.example.test", "secret-token-value", process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY!]) expect(body).not.toContain(value);
});
it.each([
  ["invalid values", { ...env, INSTAGRAM_API_VERSION: "latest", INSTAGRAM_ALLOWED_ACCOUNT_IDS: "123" }, "invalid"],
  ["origin outside allowed hosts", { ...env, INSTAGRAM_MEDIA_ALLOWED_HOSTS: "media.example.test" }, "configured"],
])("is not ready with %s", async (_label, values, versionState) => {
  const result = await getInstagramPublishingReadiness(db, values);
  expect(result.ready).toBe(false);
  expect(result.checks.INSTAGRAM_API_VERSION).toBe(versionState);
});
it.each([
  ["missing", () => db.delete(schema.marketplaceConnections).run()],
  ["disconnected", () => db.update(schema.marketplaceConnections).set({ status: "disconnected" }).run()],
  ["missing_credential", () => db.update(schema.marketplaceConnections).set({ encryptedAccessToken: null }).run()],
  ["expired", () => db.update(schema.marketplaceConnections).set({ tokenExpiresAt: "2000-01-01T00:00:00.000Z" }).run()],
])("reports connection %s without contacting Instagram", async (state, change) => {
  change();
  expect(await getInstagramPublishingReadiness(db, env)).toMatchObject({ ready: false, connection: state });
});
it("requires authentication for both read endpoints", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/social/contents", createSocialContentRouter(db));
  app.use("/api/instagram", createInstagramRouter(db, undefined, env));
  expect((await request(app).get("/api/social/contents/content/publishing-chain")).status).toBe(401);
  expect((await request(app).get("/api/instagram/publishing-readiness")).status).toBe(401);
});
