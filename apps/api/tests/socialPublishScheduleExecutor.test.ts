import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import * as media from "../src/integrations/instagram/mediaPreparation";
import { INSTAGRAM_VAULT_ACCOUNT_ID } from "../src/integrations/instagram/types";
import { createSocialPublishScheduleExecutionService } from "../src/services/socialPublishScheduleExecutions";
import { createSocialPublishScheduleExecutor } from "../src/services/socialPublishScheduleExecutor";
import { claimJobs, executeJob, failJob, retryJob, runDueJobs } from "../src/services/backgroundJobs";
import { loadInstagramCredential } from "../src/integrations/instagram/connection";
import { publishInstagramImage } from "../src/services/instagramPublishing";

vi.mock("../src/integrations/instagram/connection", () => ({ loadInstagramCredential: vi.fn(() => { throw new Error("No credentials"); }) }));
vi.mock("../src/services/instagramPublishing", () => ({ publishInstagramImage: vi.fn(() => { throw new Error("No publishing"); }) }));
let db: ReturnType<typeof createTestDb>;
let root: string;
let job: any;
const now = Date.parse("2020-01-01T00:00:00.000Z");
const inspect = media.inspectPreparedInstagramImage;
const readJob = () => db.select().from(schema.backgroundJobs).all()[0];
const execute = (token = job.claimToken) => createSocialPublishScheduleExecutor(db, "test-memory").execute(job.id, token);
function seed(suffix = "") {
  db.insert(schema.socialContents).values({ id: `content${suffix}`, productId: "product", contentType: "post", caption: "Reviewed caption", status: "approved", version: 3 }).run();
  db.insert(schema.socialContentMedia).values({ id: `selection${suffix}`, contentId: `content${suffix}`, photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({ id: `prepared${suffix}`, contentId: `content${suffix}`, sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg" }).run();
  db.insert(schema.socialContentApprovals).values({ id: `approval${suffix}`, requestId: `approval-request${suffix}`, contentId: `content${suffix}`, preparedImageId: `prepared${suffix}`, contentVersion: 2, approvedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishIntents).values({ id: `intent${suffix}`, requestId: `intent-request${suffix}`, approvalId: `approval${suffix}`, requestedByAdminUserId: "human" }).run();
  db.insert(schema.socialPublishSchedules).values({ id: `schedule${suffix}`, requestId: `schedule-request${suffix}`, publishIntentId: `intent${suffix}`, requestedByAdminUserId: "human", requestedPublicationAt: new Date(now).toISOString() }).run();
}

beforeEach(async () => {
  db = createTestDb();
  root = await mkdtemp(path.join(tmpdir(), "social-schedule-executor-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  db.insert(schema.adminUsers).values({ id: "human", email: "human@example.test", passwordHash: "fixture", role: "owner" }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  seed();
  db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, status: "connected" }).run();
  await writeFile(path.join(root, "source.webp"), await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).webp().toBuffer());
  const asset = await media.prepareInstagramImageAsset({ url: "/images/product-photos/source.webp" }, "https://api.example.test", { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" }, root);
  db.update(schema.socialPreparedImages).set({ sourceFingerprint: asset.sourceFingerprint, outputPath: asset.outputPath }).run();
  vi.spyOn(media, "inspectPreparedInstagramImage").mockImplementation((photo, image) => inspect(photo, image, root));
  await createSocialPublishScheduleExecutionService(db, "test-memory").enqueue("schedule");
  [job] = await claimJobs(db, "worker-A", 1, new Date(Date.now()+1000).toISOString());
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  expect(loadInstagramCredential).not.toHaveBeenCalled();
  expect(publishInstagramImage).not.toHaveBeenCalled();
  expect(db.select().from(schema.instagramPublishAttempts).all()).toEqual([]);
  expect(db.select().from(schema.socialPublishScheduleExecutions).all().every(row => row.instagramAttemptId === null)).toBe(true);
  vi.restoreAllMocks();
  (db as any).$client.close();
  // Remove only this test's own mkdtemp directory.
  await rm(root, { recursive: true, force: true });
});
it("validates a claimed due job and returns only canonical IDs without writes or credentials", async () => {
  const tables = [schema.backgroundJobs, schema.socialPublishScheduleExecutions, schema.socialPublishSchedules, schema.socialPublishIntents,
    schema.socialContentApprovals, schema.socialContents, schema.socialPreparedImages, schema.productPhotos, schema.marketplaceConnections];
  const before = tables.map(table => db.select().from(table).all());
  expect(await execute()).toEqual({ executionId: expect.any(String), scheduleId: "schedule", backgroundJobId: job.id,
    publishIntentId: "intent", approvalId: "approval", contentId: "content", preparedImageId: "prepared", connectionId: "connection" });
  expect(tables.map(table => db.select().from(table).all())).toEqual(before);
  expect(media.inspectPreparedInstagramImage).toHaveBeenCalledOnce();
});
it("worker dispatch uses the stored strict payload, not the supplied job snapshot", async () => {
  expect(await executeJob(db, { ...job, payloadSnapshot: '{"scheduleId":"forged","caption":"untrusted"}' })).toBe(true);
  expect(readJob()).toMatchObject({ status: "succeeded", claimToken: null });
});
it.each(["pending", "retry_pending"])("rejects %s before artifact validation and worker dispatch", async status => {
  db.update(schema.backgroundJobs).set({ status }).run();
  expect(await execute()).toBeNull();
  expect(await executeJob(db, job)).toBe(false);
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it.each([null, "", "wrong"])("rejects absent or wrong original token %s", async token => {
  expect(await execute(token as any)).toBeNull();
  expect(await executeJob(db, { ...job, claimToken: token })).toBe(false);
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it("historical NULL ownership never executes even with a fabricated token", async () => {
  db.update(schema.backgroundJobs).set({ claimToken: null }).run();
  expect(await execute()).toBeNull();
  expect(await executeJob(db, job)).toBe(false);
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it("Worker A cannot dispatch or fail after Worker B replaces its claim", async () => {
  await retryJob(db, job.id);
  const [replacement] = await claimJobs(db, "worker-B", 1, new Date(Date.now()+1000).toISOString());
  expect(replacement.claimToken).not.toBe(job.claimToken);
  expect(await execute()).toBeNull();
  expect(await executeJob(db, job)).toBe(false);
  expect(await failJob(db, job.id, { type: "Conflict", message: "stale", retryable: false }, job.claimToken)).toBe(false);
  expect(readJob()).toEqual(replacement);
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it("ownership lost during artifact inspection prevents completion", async () => {
  vi.mocked(media.inspectPreparedInstagramImage).mockImplementationOnce(async (photo, image) => {
    await retryJob(db, job.id);
    await claimJobs(db, "worker-B", 1, new Date(Date.now()+1000).toISOString());
    return inspect(photo, image, root);
  });
  expect(await executeJob(db, job)).toBe(false);
  expect(readJob()).toMatchObject({ status: "processing", lockedBy: "worker-B" });
  expect(readJob().claimToken).not.toBe(job.claimToken);
});
it.each(['{}', '{"scheduleId":""}', '{"scheduleId":"../bad"}', '{"scheduleId":"schedule","caption":"extra"}', 'null', '[]', 'malformed'])("rejects malformed/extra payload %s", async payloadSnapshot => {
  db.update(schema.backgroundJobs).set({ payloadSnapshot }).run();
  await expect(execute()).rejects.toMatchObject({ type: "Validation", retryable: false });
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it.each(["type", "schedule", "unbound", "key"])("rejects mismatched durable job identity: %s", async change => {
  if (change === "type") db.update(schema.backgroundJobs).set({ type: "other" }).run();
  if (change === "schedule") db.update(schema.backgroundJobs).set({ payloadSnapshot: '{"scheduleId":"other"}' }).run();
  if (change === "unbound") db.update(schema.socialPublishScheduleExecutions).set({ backgroundJobId: null }).run();
  if (change === "key") db.update(schema.backgroundJobs).set({ idempotencyKey: "other" }).run();
  await expect(execute()).rejects.toMatchObject({ retryable: false });
  expect(media.inspectPreparedInstagramImage).not.toHaveBeenCalled();
});
it("rejects a future schedule at execution time", async () => {
  db.update(schema.socialPublishSchedules).set({ requestedPublicationAt: "2999-01-01T00:00:00.000Z" }).run();
  await expect(execute()).rejects.toMatchObject({ type: "Conflict", retryable: false });
});
it.each(["version", "status", "selection", "ready", "product", "target", "connection", "connection-account", "actor"])("rejects changed canonical state: %s", async change => {
  if (change === "version") db.update(schema.socialContents).set({ version: 4 }).run();
  if (change === "status") db.update(schema.socialContents).set({ status: "draft" }).run();
  if (change === "selection") db.delete(schema.socialContentMedia).run();
  if (change === "ready") db.update(schema.productPhotos).set({ processingStatus: "Processing" }).run();
  if (change === "product") {
    db.insert(schema.products).values({ id: "other", sku: "other", title: "Other", slug: "other", type: "unique_item", status: "draft" }).run();
    db.update(schema.socialContents).set({ productId: "other" }).run();
  }
  if (change === "target") { (db as any).$client.exec("PRAGMA ignore_check_constraints=ON"); db.update(schema.socialContents).set({ accountLabel: "other" }).run(); }
  if (change === "connection") db.delete(schema.marketplaceConnections).run();
  if (change === "connection-account") db.update(schema.marketplaceConnections).set({ externalAccountId: "other" }).run();
  if (change === "actor") db.update(schema.adminUsers).set({ status: "disabled" }).run();
  await expect(execute()).rejects.toMatchObject({ retryable: false });
});
it.each(["missing", "corrupt", "source-changed"])("rejects stale local artifact: %s", async change => {
  const image = db.select().from(schema.socialPreparedImages).all()[0];
  if (change === "missing") await rm(path.join(root, path.basename(image.outputPath)));
  if (change === "corrupt") await writeFile(path.join(root, path.basename(image.outputPath)), "not jpeg");
  if (change === "source-changed") await writeFile(path.join(root, "source.webp"), "changed");
  await expect(execute()).rejects.toMatchObject({ type: "Validation", retryable: false });
});
it("revalidates approval after asynchronous artifact inspection", async () => {
  vi.mocked(media.inspectPreparedInstagramImage).mockImplementationOnce(async (photo, image) => {
    const valid = await inspect(photo, image, root);
    db.update(schema.socialContents).set({ version: 4 }).run();
    return valid;
  });
  await expect(execute()).rejects.toMatchObject({ type: "Conflict", retryable: false });
});
it("runner records validation failure only on the derived job", async () => {
  await retryJob(db, job.id);
  db.update(schema.socialContents).set({ version: 4 }).run();
  const schedule = db.select().from(schema.socialPublishSchedules).all();
  await runDueJobs(db, "worker", 1);
  expect(readJob()).toMatchObject({ status: "failed", claimToken: null, lastError: "Conflict: Social schedule execution validation failed" });
  expect(db.select().from(schema.socialPublishSchedules).all()).toEqual(schedule);
});
it("unexpected inspection errors cannot expose paths or secrets to job errors", async () => {
  await retryJob(db, job.id);
  vi.mocked(media.inspectPreparedInstagramImage).mockRejectedValueOnce(new Error("private-path fake-credential"));
  await runDueJobs(db, "worker", 1);
  expect(readJob()).toMatchObject({ status: "retry_pending", lastError: "Temporary: Social schedule execution validation failed" });
});
