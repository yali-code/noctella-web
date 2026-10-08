// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { reelFileName, reelFilePath } from "../src/config/mediaAssets";
import { isFfmpegAvailable, renderReel, resolveFfmpeg } from "../src/integrations/media/reelRenderer";
import { INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../src/integrations/instagram/types";
import { createReelAssetRouter } from "../src/routes/reelAssets";
import { createAdminUser } from "../src/services/adminAuth";
import { encryptCredential } from "../src/services/credentialEncryption";
import { publishInstagramImage } from "../src/services/instagramPublishing";
import { createSocialContentService } from "../src/services/socialContent";
import * as preparation from "../src/services/socialContentPreparation";

/**
 * Instagram Reel publishing through the EXISTING Social Agent chain (fake Instagram transport only;
 * no live provider call). The Reel asset is the rendered MP4 registered as the prepared asset.
 */

const env = { DATABASE_DRIVER: "test-memory", PUBLIC_API_ORIGIN: "https://api.example.test", INSTAGRAM_API_VERSION: "v24.0",
  INSTAGRAM_ALLOWED_ACCOUNT_IDS: INSTAGRAM_VAULT_ACCOUNT_ID, INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" } as NodeJS.ProcessEnv;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
let db: ReturnType<typeof createTestDb>;
let actorId: string;
let assetDir: string;
const factory = preparation.createSocialContentPreparationService;
const noPause = async () => undefined;

type Script = { containerStatus?: string[]; failCreate?: number };
function fakeInstagram(script: Script = {}) {
  const calls: { url: string; body: Record<string, string> }[] = [];
  const statuses = [...(script.containerStatus ?? ["FINISHED"])];
  const transport: InstagramTransport = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url, body });
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
    if (url.includes("/me?")) return ok({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
    if (url.endsWith("/media")) return script.failCreate ? ({ ok: false, status: script.failCreate, json: async () => ({}) } as Response) : ok({ id: "1790000111" });
    if (url.includes("/1790000111?")) return ok({ status_code: statuses.length > 1 ? statuses.shift() : statuses[0] });
    if (url.endsWith("/media_publish")) return ok({ id: "1790000999" });
    throw new Error(`Unexpected provider request ${url}`);
  });
  return { transport, calls };
}

beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("PUBLIC_API_ORIGIN", "https://api.example.test");
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  assetDir = mkdtempSync(path.join(tmpdir(), "reel-assets-"));
  vi.stubEnv("MEDIA_ASSET_DIR", assetDir);
  db = createTestDb();
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) => factory(client, "test-memory", vi.fn() as any, vi.fn().mockResolvedValue(true) as any));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live provider call allowed"));
  await createAdminUser(db, { email: "owner@example.test", password: "safe-test-password-123", role: "owner" });
  actorId = db.select().from(schema.adminUsers).get()!.id;
  db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", status: "connected", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, encryptedAccessToken: encryptCredential("test-only") }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "published" }).run();
  for (const k of [0, 1, 2]) db.insert(schema.productPhotos).values({ id: `photo-${k}`, productId: "product", processingStatus: "Ready", url: `/images/product-photos/p${k}.webp`, thumbnailUrl: "/t.webp", filename: `p${k}.webp`, mimeType: "image/webp", sizeBytes: 10, width: 100, height: 100 }).run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(assetDir, { recursive: true, force: true }); });

/** Approved reel content: draft(reel) -> ready_for_review -> prepareReel(rendered MP4) -> human approval. */
async function approvedReel(contents: Buffer = MP4) {
  const file = reelFilePath(reelFileName(randomUUID()))!;
  writeFileSync(file, contents);
  const social = createSocialContentService(db, "test-memory");
  let content = await social.create({ contentType: "reel", caption: "A closer look. #noctella", productId: "product", mediaIds: ["photo-0", "photo-1", "photo-2"] });
  content = await social.transition(content.id, { status: "ready_for_review", expectedVersion: content.version });
  const prepared = await preparation.createSocialContentPreparationService(db, "test-memory").prepareReel(content.id, "photo-0", file);
  const approval = await social.approve(content.id, { preparedImageId: prepared.id, expectedVersion: content.version, requestId: randomUUID() }, actorId);
  return { file, approvalId: approval.id, prepared };
}

describe("Social Agent Reel publishing", () => {
  it("existing IMAGE publishing is unchanged (image container, no media_type, IMAGE attempt)", async () => {
    db.insert(schema.socialContents).values({ id: "img", productId: "product", contentType: "post", caption: "Image caption", status: "ready_for_review", version: 2 }).run();
    db.insert(schema.socialContentMedia).values({ id: "sel", contentId: "img", photoId: "photo-0", sortOrder: 0 }).run();
    db.insert(schema.socialPreparedImages).values({ id: "prep-img", contentId: "img", sourcePhotoId: "photo-0", sourceFingerprint: "a".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-approved.jpg" }).run();
    const approval = await createSocialContentService(db, "test-memory").approve("img", { preparedImageId: "prep-img", expectedVersion: 2, requestId: randomUUID() }, actorId);
    const ig = fakeInstagram();
    const attempt = await publishInstagramImage(db, { approvalId: approval.id, idempotencyKey: "img-key-0001" }, actorId, ig.transport, env, noPause);
    expect(attempt).toMatchObject({ status: "published", publishedMediaId: "1790000999", mediaType: "IMAGE" });
    const create = ig.calls.find((c) => c.url.endsWith("/media"))!;
    expect(create.body).toEqual({ image_url: "https://api.example.test/images/product-photos/instagram-v1-approved.jpg", caption: "Image caption" });
  });

  it("publishes an approved Reel from the rendered MP4 (REELS container, public video_url), persisting container and media id", async () => {
    const { approvalId, prepared } = await approvedReel();
    expect(prepared).toMatchObject({ recipeVersion: "instagram-reel-v1", outputPath: expect.stringMatching(/^\/media\/reels\/reel-[0-9a-f-]{36}\.mp4$/) });
    const ig = fakeInstagram();
    const attempt = await publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0001" }, actorId, ig.transport, env, noPause);
    expect(attempt).toMatchObject({ status: "published", mediaType: "REEL", containerId: "1790000111", publishedMediaId: "1790000999" });
    const create = ig.calls.find((c) => c.url.endsWith("/media"))!;
    expect(create.body).toEqual({ media_type: "REELS", video_url: `https://api.example.test${prepared.outputPath}`, caption: "A closer look. #noctella" });
    expect(create.body).not.toHaveProperty("image_url");
    expect(db.select().from(schema.instagramPublishAttempts).get()).toMatchObject({ mediaUrl: `https://api.example.test${prepared.outputPath}`, containerId: "1790000111", publishedMediaId: "1790000999" });
  });

  it("missing or invalid MP4 fails closed (no provider call, no attempt, never an image fallback)", async () => {
    await expect((async () => { const file = reelFilePath(reelFileName(randomUUID()))!; const social = createSocialContentService(db, "test-memory"); const c = await social.create({ contentType: "reel", caption: "x", productId: "product", mediaIds: ["photo-0"] }); await preparation.createSocialContentPreparationService(db, "test-memory").prepareReel(c.id, "photo-0", file); })()).rejects.toThrow(/missing or is not a valid MP4/);

    const missing = await approvedReel();
    rmSync(missing.file);
    const ig = fakeInstagram();
    await expect(publishInstagramImage(db, { approvalId: missing.approvalId, idempotencyKey: "reel-key-0002" }, actorId, ig.transport, env, noPause)).rejects.toThrow(/not current/);

    const invalid = await approvedReel();
    writeFileSync(invalid.file, "not a video at all");
    await expect(publishInstagramImage(db, { approvalId: invalid.approvalId, idempotencyKey: "reel-key-0003" }, actorId, ig.transport, env, noPause)).rejects.toThrow(/not current/);
    expect(ig.calls).toHaveLength(0);
    expect(db.select().from(schema.instagramPublishAttempts).all()).toHaveLength(0);
  });

  it("video still processing stays resumable (bounded checks), then publishes exactly once on a later run; duplicates never re-publish", async () => {
    const { approvalId } = await approvedReel();
    const processing = fakeInstagram({ containerStatus: ["IN_PROGRESS"] });
    const first = await publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0004" }, actorId, processing.transport, env, noPause);
    expect(first).toMatchObject({ status: "processing", containerId: "1790000111", publishedMediaId: null });
    expect(processing.calls.filter((c) => c.url.includes("/1790000111?"))).toHaveLength(5); // bounded

    const later = fakeInstagram({ containerStatus: ["FINISHED"] });
    const second = await publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0004" }, actorId, later.transport, env, noPause);
    expect(second).toMatchObject({ status: "published", publishedMediaId: "1790000999" });
    expect(later.calls.filter((c) => c.url.endsWith("/media"))).toHaveLength(0); // container reused, not recreated

    const again = fakeInstagram();
    expect(await publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0004" }, actorId, again.transport, env, noPause)).toMatchObject({ status: "published" });
    expect(again.calls).toHaveLength(0);
    await expect(publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0005" }, actorId, again.transport, env, noPause)).rejects.toThrow(/already has a publishing attempt/);
    expect(db.select().from(schema.instagramPublishAttempts).all()).toHaveLength(1);
  });

  it("provider processing ERROR and container rejection become failed attempts", async () => {
    const { approvalId } = await approvedReel();
    expect(await publishInstagramImage(db, { approvalId, idempotencyKey: "reel-key-0006" }, actorId, fakeInstagram({ containerStatus: ["ERROR"] }).transport, env, noPause)).toMatchObject({ status: "failed", lastError: "invalid_media" });
    const other = await approvedReel();
    expect(await publishInstagramImage(db, { approvalId: other.approvalId, idempotencyKey: "reel-key-0007" }, actorId, fakeInstagram({ failCreate: 400 }).transport, env, noPause)).toMatchObject({ status: "failed", publishedMediaId: null });
  });

  it("public Reel delivery serves only registered, unchanged MP4s as video/mp4 by safe name", async () => {
    const { prepared, file } = await approvedReel();
    const app = express().use(createReelAssetRouter(db as any));
    const ok = await request(app).get(prepared.outputPath);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/^video\/mp4/);
    expect((await request(app).get(`/media/reels/${reelFileName(randomUUID())}`)).status).toBe(404); // unregistered
    expect((await request(app).get("/media/reels/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await request(app).get("/media/reels/reel-x.mp4")).status).toBe(404);
    writeFileSync(file, Buffer.concat([MP4, Buffer.from("tampered")]));
    expect((await request(app).get(prepared.outputPath)).status).toBe(404); // fingerprint mismatch
  });
});

describe("FFmpeg runtime (real binary)", () => {
  it("resolves FFMPEG_PATH > ffmpeg-static > PATH", () => {
    expect(resolveFfmpeg({ FFMPEG_PATH: "/opt/ffmpeg" } as NodeJS.ProcessEnv)).toEqual({ path: "/opt/ffmpeg", source: "FFMPEG_PATH" });
    expect(resolveFfmpeg({} as NodeJS.ProcessEnv).source).toBe("ffmpeg-static");
  });

  it("smoke: renders a tiny real MP4 from fixture images with the selected binary", async () => {
    expect(await isFfmpegAvailable({} as NodeJS.ProcessEnv)).toBe(true);
    const dir = mkdtempSync(path.join(tmpdir(), "ffmpeg-smoke-"));
    const photos = await Promise.all([[180, 60, 40], [40, 90, 160]].map(async (rgb, i) => {
      const p = path.join(dir, `in${i}.jpg`);
      await sharp({ create: { width: 96, height: 160, channels: 3, background: { r: rgb[0]!, g: rgb[1]!, b: rgb[2]! } } }).jpeg().toFile(p);
      return p;
    }));
    const out = path.join(dir, "smoke.mp4");
    const result = await renderReel({ photoPaths: photos, outputPath: out, durationSeconds: 1, width: 180, height: 320 }, { env: {} as NodeJS.ProcessEnv });
    expect(result.path).toBe(out);
    expect(result.bytes).toBeGreaterThan(500);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
