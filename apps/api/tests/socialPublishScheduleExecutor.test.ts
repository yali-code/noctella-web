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
import { encryptCredential } from "../src/services/credentialEncryption";

let db: ReturnType<typeof createTestDb>;
let root: string;
let job: any;
const now = Date.parse("2020-01-01T00:00:00.000Z");
const env = { DATABASE_DRIVER: "test-memory", PUBLIC_API_ORIGIN: "https://api.example.test", INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test",
  INSTAGRAM_API_VERSION: "v24.0" };
const inspect = media.inspectPreparedInstagramImage;
const readJob = () => db.select().from(schema.backgroundJobs).all()[0];
const readAttempts = () => db.select().from(schema.instagramPublishAttempts).all();
const readExecution = () => db.select().from(schema.socialPublishScheduleExecutions).all()[0];
const execute = (token = job.claimToken) => createSocialPublishScheduleExecutor(db, "test-memory", Date.now, env).execute(job.id, token);
const executionKey = () => `social-publish-execution:${readExecution().id}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let calls: string[];
let faults: string[];
let onAccount: (() => Promise<void>) | undefined;
let publishFails: boolean;
const containerCalls = () => calls.filter(call => call.startsWith("POST ") && call.endsWith("/media"));
function insertAttempt(values: Record<string, unknown>) {
  const image = db.select().from(schema.socialPreparedImages).all()[0];
  db.insert(schema.instagramPublishAttempts).values({ id: "igp_existing", approvalId: "approval", connectionId: "connection",
    idempotencyKey: executionKey(), caption: "Reviewed caption", mediaUrl: `https://api.example.test${image.outputPath}`,
    status: "pending", providerEntryState: "unclaimed", ...values } as any).run();
}
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
  calls = []; faults = []; onAccount = undefined; publishFails = false;
  // Fake provider only. Every request must observe a committed execution -> attempt binding.
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any) => {
    const url = String(input);
    // The client masks transport errors, so fake-side assertion failures are surfaced in afterEach.
    try {
      expect((db as any).$client.inTransaction).toBe(false);
      expect(readExecution().instagramAttemptId).toBe(readAttempts().find(row => row.idempotencyKey === executionKey())?.id);
    } catch (error) { faults.push(String(error)); throw error; }
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.includes("/me?")) { await onAccount?.(); return json({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" }); }
    if (url.endsWith("/media")) return json({ id: "111" });
    if (url.includes("/111?")) return json({ status_code: "FINISHED" });
    if (url.endsWith("/media_publish")) return publishFails ? new Response("{}", { status: 500 }) : json({ id: "222" });
    faults.push(`Unexpected provider request ${url}`);
    throw new Error("Unexpected provider request");
  }) as any);
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("PUBLIC_API_ORIGIN", env.PUBLIC_API_ORIGIN);
  vi.stubEnv("INSTAGRAM_MEDIA_ALLOWED_HOSTS", env.INSTAGRAM_MEDIA_ALLOWED_HOSTS);
  vi.stubEnv("INSTAGRAM_API_VERSION", env.INSTAGRAM_API_VERSION);
  db.insert(schema.adminUsers).values({ id: "human", email: "human@example.test", passwordHash: "fixture", role: "owner" }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp", thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  seed();
  db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, status: "connected", encryptedAccessToken: encryptCredential("test-only") }).run();
  await writeFile(path.join(root, "source.webp"), await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).webp().toBuffer());
  const asset = await media.prepareInstagramImageAsset({ url: "/images/product-photos/source.webp" }, "https://api.example.test", { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" }, root);
  db.update(schema.socialPreparedImages).set({ sourceFingerprint: asset.sourceFingerprint, outputPath: asset.outputPath }).run();
  vi.spyOn(media, "inspectPreparedInstagramImage").mockImplementation((photo, image) => inspect(photo, image, root));
  await createSocialPublishScheduleExecutionService(db, "test-memory").enqueue("schedule");
  [job] = await claimJobs(db, "worker-A", 1, new Date(Date.now()+1000).toISOString());
});
afterEach(async () => {
  expect(faults).toEqual([]);
  // One execution -> at most one attempt and at most one remote container, ever.
  expect(readAttempts().filter(row => row.idempotencyKey === `social-publish-execution:${readExecution().id}`).length).toBeLessThanOrEqual(1);
  expect(containerCalls().length).toBeLessThanOrEqual(1);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  (db as any).$client.close();
  // Remove only this test's own mkdtemp directory.
  await rm(root, { recursive: true, force: true });
});
it("validates a claimed due job and durably binds exactly one unstarted approval-bound attempt", async () => {
  const tables = [schema.backgroundJobs, schema.socialPublishSchedules, schema.socialPublishIntents,
    schema.socialContentApprovals, schema.socialContents, schema.socialPreparedImages, schema.productPhotos, schema.marketplaceConnections];
  const before = tables.map(table => db.select().from(table).all());
  const result = await execute();
  const [attempt] = readAttempts();
  expect(result).toEqual({ executionId: readExecution().id, scheduleId: "schedule", backgroundJobId: job.id, publishIntentId: "intent",
    approvalId: "approval", contentId: "content", preparedImageId: "prepared", connectionId: "connection", instagramAttemptId: attempt.id });
  // The same keyed approval-bound attempt went through the existing state machine to publication.
  expect(attempt).toMatchObject({ approvalId: "approval", connectionId: "connection", idempotencyKey: executionKey(), caption: "Reviewed caption",
    status: "published", providerEntryState: "claimed", containerId: "111", publishedMediaId: "222" });
  expect(attempt.id).toMatch(/^igp_/);
  expect(readExecution().instagramAttemptId).toBe(attempt.id);
  expect(calls.map(call => call.replace(/^(\w+) .*\//, "$1 /"))).toEqual(["GET /me", "POST /media", "GET /111", "POST /media_publish"]);
  expect(tables.map(table => db.select().from(table).all())).toEqual(before);
  // Replay resolves the same published attempt: no second attempt and no provider request.
  expect((await execute())?.instagramAttemptId).toBe(attempt.id);
  expect(readAttempts()).toEqual([attempt]);
  expect(calls).toHaveLength(4);
});
it("worker completes only after publication, using the stored strict payload", async () => {
  expect(await executeJob(db, { ...job, payloadSnapshot: '{"scheduleId":"forged","caption":"untrusted"}' })).toBe(true);
  expect(readJob()).toMatchObject({ status: "succeeded", claimToken: null });
  expect(readAttempts()[0]).toMatchObject({ status: "published", caption: "Reviewed caption" });
  expect(readExecution().instagramAttemptId).toBe(readAttempts()[0].id);
});
it("concurrent deliveries under the same claim converge to one attempt and one container", async () => {
  const results = await Promise.allSettled([execute(), execute()]);
  expect(results.some(result => result.status === "fulfilled" && result.value?.instagramAttemptId === readAttempts()[0].id)).toBe(true);
  expect(readAttempts()).toHaveLength(1);
  expect(readAttempts()[0].status).toBe("published");
  expect(containerCalls()).toHaveLength(1);
});
it("recovers an existing keyed unstarted attempt left unbound by a crash and publishes that same attempt", async () => {
  insertAttempt({});
  expect((await execute())?.instagramAttemptId).toBe("igp_existing");
  expect(readExecution().instagramAttemptId).toBe("igp_existing");
  expect(readAttempts()).toEqual([expect.objectContaining({ id: "igp_existing", status: "published", containerId: "111" })]);
});
it.each([
  ["claimed without container", { status: "pending", providerEntryState: "claimed" }],
  ["publishing", { status: "publishing", providerEntryState: "claimed", containerId: "111" }],
  ["reconciliation_required", { status: "reconciliation_required", providerEntryState: "claimed", containerId: "111" }],
])("ambiguous %s is bound but never re-entered or republished", async (_label, values) => {
  insertAttempt(values);
  const before = readAttempts();
  await expect(executeJob(db, job)).rejects.toMatchObject({ type: "Conflict", retryable: false });
  expect(readExecution().instagramAttemptId).toBe("igp_existing");
  expect(readAttempts()).toEqual(before);
  expect(calls).toEqual([]);
  expect(readJob().status).toBe("processing");
});
it("a durable container resumes without creating another container", async () => {
  insertAttempt({ status: "container_created", providerEntryState: "claimed", containerId: "111" });
  expect((await execute())?.instagramAttemptId).toBe("igp_existing");
  expect(containerCalls()).toEqual([]);
  expect(readAttempts()[0]).toMatchObject({ status: "published", containerId: "111", publishedMediaId: "222" });
});
it("ownership lost after binding stops provider entry before the irreversible claim", async () => {
  onAccount = async () => {
    await retryJob(db, job.id);
    await claimJobs(db, "worker-B", 1, new Date(Date.now()+1000).toISOString());
  };
  expect(await executeJob(db, job)).toBe(false);
  expect(readAttempts()[0]).toMatchObject({ status: "pending", providerEntryState: "unclaimed", containerId: null });
  expect(readExecution().instagramAttemptId).toBe(readAttempts()[0].id);
  expect(containerCalls()).toEqual([]);
  expect(readJob()).toMatchObject({ status: "processing", lockedBy: "worker-B" });
});
it("provider publish failure becomes reconciliation_required and never succeeds the job", async () => {
  await retryJob(db, job.id);
  publishFails = true;
  await runDueJobs(db, "worker", 1);
  expect(readAttempts()[0]).toMatchObject({ status: "reconciliation_required", containerId: "111" });
  expect(readJob()).toMatchObject({ status: "failed", lastError: "Conflict: Social schedule execution validation failed" });
  // Admin retry re-delivers the job, but the ambiguous publish is never repeated.
  await retryJob(db, job.id);
  await runDueJobs(db, "worker", 1);
  expect(calls.filter(call => call.endsWith("/media_publish"))).toHaveLength(1);
  expect(readJob().status).toBe("failed");
});
it.each(["other-approval", "historical", "consumed"])("never adopts an incompatible attempt: %s", async kind => {
  if (kind === "other-approval") { seed("2"); insertAttempt({ approvalId: "approval2" }); }
  if (kind === "historical") insertAttempt({ approvalId: null, providerEntryState: null });
  if (kind === "consumed") insertAttempt({ idempotencyKey: "manual-publish-key" });
  const before = readAttempts();
  await expect(execute()).rejects.toMatchObject({ type: "Conflict", retryable: false });
  expect(readExecution().instagramAttemptId).toBeNull();
  expect(readAttempts()).toEqual(before);
});
it("an execution bound to another attempt fails closed and creates nothing", async () => {
  insertAttempt({ id: "igp_other", approvalId: null, idempotencyKey: "historical-key", providerEntryState: null });
  db.update(schema.socialPublishScheduleExecutions).set({ instagramAttemptId: "igp_other" }).run();
  await expect(executeJob(db, job)).rejects.toMatchObject({ type: "Conflict", retryable: false });
  expect(readJob().status).toBe("processing");
  expect(readAttempts().map(row => row.id)).toEqual(["igp_other"]);
});
it("ownership lost before the attempt transaction cannot create or bind an attempt", async () => {
  vi.mocked(media.inspectPreparedInstagramImage)
    .mockImplementationOnce((photo, image) => inspect(photo, image, root))
    .mockImplementationOnce(async (photo, image) => {
      await retryJob(db, job.id);
      await claimJobs(db, "worker-B", 1, new Date(Date.now()+1000).toISOString());
      return inspect(photo, image, root);
    });
  expect(await executeJob(db, job)).toBe(false);
  expect(readAttempts()).toEqual([]);
  expect(readExecution().instagramAttemptId).toBeNull();
  expect(readJob()).toMatchObject({ status: "processing", lockedBy: "worker-B" });
});
it("credential failure fails closed: no attempt, no binding, job not succeeded", async () => {
  await retryJob(db, job.id);
  db.update(schema.marketplaceConnections).set({ encryptedAccessToken: null }).run();
  await runDueJobs(db, "worker", 1);
  expect(readJob()).toMatchObject({ status: "failed", lastError: "Permanent: Social schedule execution validation failed" });
  expect(readAttempts()).toEqual([]);
  expect(readExecution().instagramAttemptId).toBeNull();
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
