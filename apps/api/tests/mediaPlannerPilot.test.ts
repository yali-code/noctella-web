// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createAdminUser } from "../src/services/adminAuth";
import * as preparation from "../src/services/socialContentPreparation";
import * as publishing from "../src/services/instagramPublishing";
import * as jobs from "../src/services/backgroundJobs";
import { buildFfmpegArgs, renderReel, type CommandRunner } from "../src/integrations/media/reelRenderer";
import type { MediaCopyProvider } from "../src/integrations/media/mediaCopyProviders";
import {
  approveMediaPlan, deterministicRequestId, editMediaPlanItem, generateMediaPlan, getMediaPlannerReadiness, MediaPlanningBlockedError,
  getLatestMediaPlan, rejectMediaPlan, renderPlanReel, scheduleMediaPlan, type MediaPlannerDeps,
} from "../src/services/mediaPlanner";
import { recommendPostingHours, zonedTimeToUtc } from "../src/use-cases/media-planning/planner";

/**
 * Media Planning Agent pilot: planner proposes -> owner approves -> Social Agent chain executes.
 * Never calls Instagram, OpenAI or a real ffmpeg; product rows are never mutated.
 */

const NOW = new Date("2030-10-05T12:00:00.000Z");
let db: ReturnType<typeof createTestDb>;
let actorId: string;
let assetDir: string;
const render = vi.fn();
const inspect = vi.fn();
const factory = preparation.createSocialContentPreparationService;

/** Fake ffmpeg: writes a minimal ISO-BMFF (ftyp) file at the output path (last argument). */
const fakeFfmpeg: CommandRunner = async (_cmd, args) => {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
  writeFileSync(args[args.length - 1]!, ftyp);
};
const deps = (overrides: Partial<MediaPlannerDeps> = {}): MediaPlannerDeps => ({
  driver: "test-memory", now: () => NOW, copyProvider: null, ffmpegAvailable: async () => true,
  render: (input, options) => renderReel(input, { ...options, run: fakeFfmpeg }),
  env: { ...process.env, MEDIA_ASSET_DIR: assetDir, MEDIA_PLANNER_TIMEZONE: "Europe/Sofia" }, ...overrides,
});

function seedProducts(count: number) {
  const categories = ["Cameras", "Pens", "Watches"];
  categories.forEach((name, i) => db.insert(schema.categories).values({ id: `cat-${i}`, name, slug: name.toLowerCase() }).run());
  for (let n = 1; n <= count; n += 1) {
    db.insert(schema.products).values({ id: `p-${n}`, sku: `SKU-${n}`, title: `Item ${n}`, slug: `item-${n}`, type: "unique_item", status: "published", stockQuantity: 1, categoryId: `cat-${n % 3}`, brand: n === 1 ? "Olympus" : null, createdAt: `2030-0${(n % 9) + 1}-01T00:00:00.000Z`, updatedAt: "2030-01-01T00:00:00.000Z" }).run();
    const photos = n === 1 ? 5 : 1;
    for (let k = 0; k < photos; k += 1) {
      db.insert(schema.productPhotos).values({ id: `ph-${n}-${k}`, productId: `p-${n}`, processingStatus: "Ready", url: `/images/product-photos/p${n}-${k}.webp`, thumbnailUrl: `/t${n}${k}.webp`, filename: `p${n}-${k}.webp`, mimeType: "image/webp", sizeBytes: 10, width: 100, height: 100, isPrimary: k === 0, sortOrder: k }).run();
    }
  }
  // Ineligible noise: sold, out of stock, and a product without a Ready photo.
  db.insert(schema.products).values({ id: "sold", sku: "SOLD", title: "Sold", slug: "sold", type: "unique_item", status: "sold", stockQuantity: 0 }).run();
  db.insert(schema.products).values({ id: "nophoto", sku: "NOPHOTO", title: "No photo", slug: "nophoto", type: "unique_item", status: "published", stockQuantity: 1 }).run();
  db.insert(schema.productPhotos).values({ id: "ph-pending", productId: "nophoto", processingStatus: "Pending", url: "/images/product-photos/pending.webp", thumbnailUrl: "/x.webp", filename: "pending.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1 }).run();
}
const productSnapshot = () => [db.select().from(schema.products).all(), db.select().from(schema.productPhotos).all()];

beforeEach(async () => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("PUBLIC_API_ORIGIN", "https://api.example.test");
  db = createTestDb();
  assetDir = mkdtempSync(path.join(tmpdir(), "media-planner-"));
  vi.stubEnv("MEDIA_ASSET_DIR", assetDir);
  render.mockReset().mockImplementation(async () => ({ sourceFingerprint: "f".repeat(64), recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg", url: "https://api.example.test/prepared.jpg" }));
  inspect.mockReset().mockResolvedValue(true);
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) => factory(client, "test-memory", render, inspect));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
  vi.spyOn(publishing, "publishInstagramImage").mockRejectedValue(new Error("Planner must never publish"));
  vi.spyOn(jobs, "enqueueJob").mockRejectedValue(new Error("Planner must never enqueue"));
  await createAdminUser(db, { email: "owner@example.test", password: "safe-test-password-123", role: "owner" });
  actorId = db.select().from(schema.adminUsers).get()!.id;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Media Planning Agent - planning", () => {
  it("blocks planning with fewer than 7 eligible products (ineligible products are not counted)", async () => {
    seedProducts(6);
    await expect(generateMediaPlan(db, { generatedBy: actorId }, deps())).rejects.toMatchObject({ blockers: ["INSUFFICIENT_ELIGIBLE_PRODUCTS:6/7"] });
    await expect(generateMediaPlan(db, { generatedBy: actorId }, deps())).rejects.toBeInstanceOf(MediaPlanningBlockedError);
  });

  it("generates exactly 4 feed posts + 1 Reel over 4 days from real ERP photos, diverse and unrepeated, with policy-labelled times", async () => {
    seedProducts(8);
    const before = productSnapshot();
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps());
    expect(productSnapshot()).toEqual(before);

    expect(plan.status).toBe("READY_FOR_REVIEW");
    expect(plan.copySource).toBe("deterministic");
    expect([plan.startDate, plan.endDate]).toEqual(["2030-10-06", "2030-10-09"]);
    const feed = plan.items.filter((i) => i.contentType === "FEED_POST"), reel = plan.items.find((i) => i.contentType === "REEL")!;
    expect([feed.length, plan.items.length]).toEqual([4, 5]);
    expect(new Set(plan.items.map((i) => i.plannedAt.slice(0, 10))).size).toBe(4);
    expect(new Set(plan.items.map((i) => i.product.id)).size).toBe(5); // no repeated product
    expect(new Set(feed.map((i) => i.product.category)).size).toBe(3); // category diversity
    const realPhotoIds = new Set(db.select().from(schema.productPhotos).all().filter((p) => p.processingStatus === "Ready").map((p) => p.id));
    for (const item of plan.items) {
      expect(item.photos.every((p) => realPhotoIds.has(p.id) && p.url?.startsWith("/images/product-photos/"))).toBe(true);
      expect(item.hashtags).toHaveLength(5);
      expect(item.timeBasis).toBe("TIME_RECOMMENDATION_POLICY_BASED");
    }
    expect(plan.timeRecommendation).toBe("TIME_RECOMMENDATION_POLICY_BASED");
    expect(feed.every((i) => i.postFormat === "SINGLE_IMAGE" && i.photos.length === 1)).toBe(true);
    // Sun 2030-10-06 11:00 Sofia (UTC+3, DST) = 08:00Z ; Mon 19:00 = 16:00Z ; Reel = feed + 90 min on day 3.
    expect(feed[0]!.plannedAt).toBe("2030-10-06T08:00:00.000Z");
    expect(feed[1]!.plannedAt).toBe("2030-10-07T16:00:00.000Z");
    expect(reel).toMatchObject({ plannedAt: "2030-10-08T17:30:00.000Z", product: { id: "p-1" }, postFormat: "REEL" });
    expect(reel.photos.map((p) => p.id)).toEqual(["ph-1-0", "ph-1-1", "ph-1-2", "ph-1-3", "ph-1-4"]);
    expect(reel.hook).toBeTruthy();
    expect(reel.reel).toMatchObject({ status: "RENDERED", previewPath: expect.stringContaining("/reel") });
    expect(plan.items.some((i) => i.product.id === "sold" || i.product.id === "nophoto")).toBe(false);
  });

  it("uses the configured copy provider when available and falls back to fact-only copy on invalid AI output", async () => {
    seedProducts(7);
    const good: MediaCopyProvider = { source: "fake-ai", generate: async (items) => Object.fromEntries(items.map((i) => [i.key, { caption: `Caption for ${i.product.sku}`, hashtags: ["#a1", "#b2", "#c3", "#d4", "#e5"], hook: i.kind === "reel" ? "Look closer" : null, rationale: "fake", frameTexts: null, finalFrameText: i.kind === "reel" ? "Noctella" : null }])) };
    expect((await generateMediaPlan(db, { generatedBy: actorId }, deps({ copyProvider: good }))).items[0]!.caption).toMatch(/^Caption for SKU-/);
    const bad: MediaCopyProvider = { source: "fake-ai", generate: async () => { throw new Error("MEDIA_COPY_PROVIDER_INVALID_RESPONSE"); } };
    expect((await generateMediaPlan(db, { generatedBy: actorId }, deps({ copyProvider: bad }))).copySource).toBe("deterministic_fallback:MEDIA_COPY_PROVIDER_INVALID_RESPONSE");
  });

  it("time recommendation is data-driven only with enough Noctella evidence", () => {
    expect(recommendPostingHours([], "Europe/Sofia").basis).toBe("TIME_RECOMMENDATION_POLICY_BASED");
    const evidence = Array.from({ length: 12 }, (_, i) => ({ publishedAt: zonedTimeToUtc(`2030-09-${String(i + 1).padStart(2, "0")}`, i < 6 ? 20 : 9, 0, "Europe/Sofia"), reach: i < 6 ? 500 : 100 }));
    expect(recommendPostingHours(evidence, "Europe/Sofia")).toMatchObject({ basis: "TIME_RECOMMENDATION_DATA_DRIVEN", feedHour: 20 });
  });
});

describe("Media Planning Agent - Reel renderer", () => {
  it("builds a 9:16 ~8s H.264 command from real photo files and returns a validated MP4 reference", async () => {
    const args = buildFfmpegArgs({ photoPaths: ["/a.webp", "/b.webp", "/c.webp", "/d.webp"], outputPath: "/out.mp4", hookText: "Look: closer \"now\"", finalText: "Noctella", fontFile: "/fonts/f.ttf" });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(args.filter((a) => a === "-i")).toHaveLength(4);
    expect(filter).toContain("crop=1080:1920");
    expect(filter.match(/xfade=transition=fade/g)).toHaveLength(3);
    expect(filter).toContain("text='Look closer now'");
    expect(args).toEqual(expect.arrayContaining(["-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/out.mp4"]));

    const out = path.join(mkdtempSync(path.join(tmpdir(), "reel-")), "r.mp4");
    expect(await renderReel({ photoPaths: ["/a.webp"], outputPath: out }, { run: fakeFfmpeg })).toEqual({ path: out, bytes: 24 });
    expect(readFileSync(out).subarray(4, 8).toString("ascii")).toBe("ftyp");
    await expect(renderReel({ photoPaths: ["/a.webp"], outputPath: out }, { run: async (_c, a) => writeFileSync(a[a.length - 1]!, "not a video") })).rejects.toThrow("REEL_RENDER_INVALID_OUTPUT");
    await expect(renderReel({ photoPaths: ["/a.webp"], outputPath: out }, { run: async () => { throw new Error("spawn ENOENT"); } })).rejects.toThrow("REEL_RENDER_FAILED");
  });

  it("without ffmpeg the Reel is never marked complete", async () => {
    seedProducts(7);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps({ ffmpegAvailable: async () => false }));
    expect(plan.items.find((i) => i.contentType === "REEL")!.reel).toEqual({ status: "RENDERER_UNAVAILABLE", previewPath: null });
  });
});

describe("Media Planning Agent - review, approval and Social Agent hand-off", () => {
  it("owner can edit product/photo/caption/hashtags/time before approval; not after", async () => {
    seedProducts(8);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps());
    const item = plan.items[0]!;
    const unused = ["p-1", "p-2", "p-3", "p-4", "p-5", "p-6", "p-7", "p-8"].find((id) => !plan.items.some((i) => i.product.id === id))!;
    const edited = editMediaPlanItem(db, plan.id, item.id, { expectedVersion: item.version, productId: unused, caption: "Owner caption", hashtags: ["#owner", "#edit"], plannedAt: "2030-10-06T15:15:00.000Z" }, deps());
    expect(edited.items[0]).toMatchObject({ product: { id: unused }, caption: "Owner caption", hashtags: ["#owner", "#edit"], plannedAt: "2030-10-06T15:15:00.000Z", timeBasis: "OWNER_EDITED", status: "EDITED" });
    expect(() => editMediaPlanItem(db, plan.id, item.id, { expectedVersion: item.version, caption: "stale" }, deps())).toThrow(/changed/);
    expect(() => editMediaPlanItem(db, plan.id, item.id, { expectedVersion: edited.items[0]!.version, photoIds: ["ph-1-0"] }, deps())).toThrow(/photos/);
    const reel = edited.items.find((i) => i.contentType === "REEL")!;
    expect(editMediaPlanItem(db, plan.id, reel.id, { expectedVersion: reel.version, photoIds: ["ph-1-0", "ph-1-1"] }, deps()).items.find((i) => i.id === reel.id)!.reel!.status).toBe("RENDER_REQUIRED");

    approveMediaPlan(db, plan.id, actorId, deps());
    expect(() => editMediaPlanItem(db, plan.id, item.id, { expectedVersion: 99, caption: "late" }, deps())).toThrow(/awaiting review/);
  });

  it("cannot schedule an unapproved or rejected plan", async () => {
    seedProducts(7);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps());
    await expect(scheduleMediaPlan(db, plan.id, actorId, deps())).rejects.toThrow(/approved plan/);
    rejectMediaPlan(db, plan.id, deps());
    await expect(scheduleMediaPlan(db, plan.id, actorId, deps())).rejects.toThrow(/approved plan/);
    expect(db.select().from(schema.socialContents).all()).toHaveLength(0);
  });

  it("approval + scheduling creates existing social-chain records idempotently and never publishes", async () => {
    seedProducts(7);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps());
    approveMediaPlan(db, plan.id, actorId, deps());
    const scheduled = await scheduleMediaPlan(db, plan.id, actorId, deps());

    expect(scheduled.status).toBe("SCHEDULED");
    const feed = scheduled.items.filter((i) => i.contentType === "FEED_POST");
    expect(feed.every((i) => i.status === "SCHEDULED" && i.socialChain.publishScheduleId)).toBe(true);
    const reel = scheduled.items.find((i) => i.contentType === "REEL")!;
    expect(reel).toMatchObject({ status: "SCHEDULED", socialChain: { publishScheduleId: expect.any(String) } });
    const reelContent = db.select().from(schema.socialContents).all().find((c) => c.id === reel.socialChain.socialContentId)!;
    expect(reelContent.contentType).toBe("reel");
    expect(db.select().from(schema.socialPreparedImages).all().find((p) => p.contentId === reelContent.id)).toMatchObject({ recipeVersion: "instagram-reel-v1", outputPath: `/media/reels/reel-${reel.id}.mp4` });
    const counts = () => [schema.socialContents, schema.socialContentApprovals, schema.socialPublishIntents, schema.socialPublishSchedules].map((t) => db.select().from(t).all().length);
    expect(counts()).toEqual([5, 5, 5, 5]);
    const contents = db.select().from(schema.socialContents).all();
    expect(contents.every((c) => c.status === "approved" && c.concept?.startsWith("media-plan-item:"))).toBe(true);
    expect(contents[0]!.caption).toMatch(/#noctella/);
    const schedules = db.select().from(schema.socialPublishSchedules).all();
    expect(schedules.map((s) => s.requestedPublicationAt).sort()).toEqual(scheduled.items.map((i) => i.plannedAt).sort());
    expect(db.select().from(schema.socialContentApprovals).all().map((a) => a.requestId).sort()).toEqual(scheduled.items.map((i) => deterministicRequestId(i.id, "approval")).sort());

    // Repeat approval and scheduling: no duplicates anywhere.
    approveMediaPlan(db, plan.id, actorId, deps());
    await scheduleMediaPlan(db, plan.id, actorId, deps());
    expect(counts()).toEqual([5, 5, 5, 5]);
    expect(db.select().from(schema.backgroundJobs).all()).toHaveLength(0);
    expect(publishing.publishInstagramImage).not.toHaveBeenCalled();
    expect(jobs.enqueueJob).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a hand-off interrupted after content creation resumes without duplicating content", async () => {
    seedProducts(7);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps());
    approveMediaPlan(db, plan.id, actorId, deps());
    render.mockRejectedValueOnce(new Error("disk full"));
    await expect(scheduleMediaPlan(db, plan.id, actorId, deps())).rejects.toThrow();
    expect(db.select().from(schema.socialContents).all()).toHaveLength(1);
    await scheduleMediaPlan(db, plan.id, actorId, deps());
    expect(db.select().from(schema.socialContents).all()).toHaveLength(5);
  });

  it("a plan is not SCHEDULED at 4/5 (Reel not rendered fails closed) and becomes SCHEDULED at 5/5", async () => {
    seedProducts(7);
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, deps({ ffmpegAvailable: async () => false }));
    approveMediaPlan(db, plan.id, actorId, deps());
    await expect(scheduleMediaPlan(db, plan.id, actorId, deps())).rejects.toThrow(/not rendered/);
    const partial = getLatestMediaPlan(db)!;
    expect(partial.status).toBe("APPROVED");
    expect(partial.items.filter((i) => i.status === "SCHEDULED")).toHaveLength(4);
    const reel = partial.items.find((i) => i.contentType === "REEL")!;
    await renderPlanReel(db, plan.id, reel.id, deps());
    const done = await scheduleMediaPlan(db, plan.id, actorId, deps());
    expect(done.status).toBe("SCHEDULED");
    expect(done.items.every((i) => i.status === "SCHEDULED")).toBe(true);
    await expect(renderPlanReel(db, plan.id, reel.id, deps())).rejects.toThrow(/before scheduling|re-rendered/);
  });

  it("readiness reports counts and blockers without secrets", async () => {
    seedProducts(6);
    const empty = await getMediaPlannerReadiness(db, deps({ ffmpegAvailable: async () => false }));
    expect(empty).toMatchObject({ eligibleProductCount: 6, requiredProductCount: 7, ffmpegAvailable: false, planExists: false, feedPostsScheduled: 0, reelScheduled: false, reelPublishingSupported: true, technicallyReady: false, ready: false });
    expect(empty.blockers).not.toContain("MANUAL_PUBLISH_REQUIRED");
    expect(empty.blockers).toEqual(expect.arrayContaining(["INSUFFICIENT_ELIGIBLE_PRODUCTS:6/7", "INSTAGRAM_PUBLISHING_NOT_READY", "REEL_RENDERER_UNAVAILABLE", "NO_PLAN"]));
    expect(JSON.stringify(empty)).not.toMatch(/token|secret|password/i);
  });

  it("readiness is fully ready only when inventory, Instagram, ffmpeg, asset dir, video delivery and a 5/5 scheduled plan are all in place", async () => {
    vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    const { encryptCredential } = await import("../src/services/credentialEncryption");
    const { INSTAGRAM_VAULT_ACCOUNT_ID } = await import("../src/integrations/instagram/types");
    db.insert(schema.marketplaceConnections).values({ id: "ig", channel: "instagram", accountLabel: "vault", status: "connected", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, encryptedAccessToken: encryptCredential("test-only") }).run();
    seedProducts(7);
    const ready = deps({ env: { ...process.env, MEDIA_ASSET_DIR: assetDir, PUBLIC_API_ORIGIN: "https://api.example.test", INSTAGRAM_API_VERSION: "v24.0", INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test", INSTAGRAM_ALLOWED_ACCOUNT_IDS: INSTAGRAM_VAULT_ACCOUNT_ID, DATABASE_DRIVER: "test-memory" } });
    const before = await getMediaPlannerReadiness(db, ready);
    expect(before).toMatchObject({ technicallyReady: true, ready: false, ffmpegAvailable: true, mediaAssetDirWritable: true, publicVideoDeliveryReady: true, instagramPublishingReady: true, blockers: ["NO_PLAN"] });
    const plan = await generateMediaPlan(db, { generatedBy: actorId }, ready);
    approveMediaPlan(db, plan.id, actorId, ready);
    await scheduleMediaPlan(db, plan.id, actorId, ready);
    expect(await getMediaPlannerReadiness(db, ready)).toMatchObject({ ready: true, blockers: [], feedPostsScheduled: 4, reelScheduled: true, planStatus: "SCHEDULED" });
  });
});
