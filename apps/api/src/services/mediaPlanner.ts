import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DbClient } from "../db/client";
import { resolvePublicApiOrigin } from "../config/publicApiOrigin";
import { createConfiguredMediaCopyProvider, DeterministicMediaCopyProvider, type MediaCopyProvider, type MediaCopyRequestItem } from "../integrations/media/mediaCopyProviders";
import { isFfmpegAvailable, renderReel, resolveFfmpeg } from "../integrations/media/reelRenderer";
import { mediaAssetDir, REEL_PUBLIC_PATH, reelFileName } from "../config/mediaAssets";
import { validateInstagramMediaUrl } from "../config/instagramConfig";
import { access, constants as fsConstants } from "node:fs/promises";
import { createMediaPlanRepository } from "../repositories/media-planning/sqlite";
import { createSqliteSocialAnalyticsRepository } from "../repositories/analytics/socialAnalyticsSqlite";
import {
  DEFAULT_PLANNER_TIMEZONE, defaultStartDate, editPlanItemSchema, eligibleProducts, FEED_POSTS, MIN_ELIGIBLE_PRODUCTS, planDates, recommendPostingHours,
  REEL_DAY_INDEX, REEL_MAX_PHOTOS, selectPlanProducts, slotFor, type EligibleProduct, type PlanItemCopy, type PublishedPerformance,
} from "../use-cases/media-planning/planner";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { getInstagramPublishingReadiness } from "./instagramPublishingReadiness";
import { productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { createSocialContentService } from "./socialContent";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { createSocialPublishIntentService } from "./socialPublishIntents";
import { createSocialPublishScheduleService } from "./socialPublishSchedules";

/**
 * Media Planning Agent. PLANNER PROPOSES -> OWNER APPROVES -> SOCIAL AGENT EXECUTES.
 * The planner never publishes and never edits products: after explicit owner approval it hands
 * approved feed posts to the existing chain (social_contents -> social_content_approvals ->
 * social_publish_intents -> social_publish_schedules); the existing scheduler/executor publishes.
 * Feed posts are SINGLE_IMAGE; the Reel is the rendered MP4, registered as the content's prepared
 * asset and published by the same chain as an Instagram Reel (carousel is not supported).
 */

export class MediaPlanningBlockedError extends Error {
  constructor(readonly blockers: readonly string[]) { super(`MEDIA_PLANNING_BLOCKED: ${blockers.join(",")}`); this.name = "MediaPlanningBlockedError"; }
}

export interface MediaPlannerDeps {
  readonly driver?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** undefined = configured provider (AI Intake OpenAI config) or deterministic; null = deterministic. */
  readonly copyProvider?: MediaCopyProvider | null;
  readonly render?: typeof renderReel;
  readonly ffmpegAvailable?: () => Promise<boolean>;
}

const driverOf = (deps: MediaPlannerDeps) => deps.driver ?? process.env.DATABASE_DRIVER ?? "sqlite";
const nowOf = (deps: MediaPlannerDeps) => (deps.now ?? (() => new Date()))();
const envOf = (deps: MediaPlannerDeps) => deps.env ?? process.env;
const timezoneOf = (env: NodeJS.ProcessEnv) => env.MEDIA_PLANNER_TIMEZONE?.trim() || DEFAULT_PLANNER_TIMEZONE;
export { mediaAssetDir };
const parse = <T>(json: string | null, fallback: T): T => { try { return json ? JSON.parse(json) : fallback; } catch { return fallback; } };

/** Deterministic canonical UUID for a plan item + purpose: re-approval replays the same social-chain requests. */
export function deterministicRequestId(itemId: string, purpose: string): string {
  const h = createHash("sha256").update(`media-plan:${itemId}:${purpose}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Resolves a stored product photo URL to its file inside the product-photo root (never outside it). */
export function localPhotoPath(url: string): string | null {
  if (!url.startsWith(`${productPhotoStaticPath}/`)) return null;
  const name = url.slice(productPhotoStaticPath.length + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return path.join(productPhotoStaticRoot, name);
}

function instagramEvidence(db: DbClient): PublishedPerformance[] {
  const latest = new Map<string, { publishedAt: string; reach: number }>();
  for (const row of createSqliteSocialAnalyticsRepository(db).listSocialSnapshots(["instagram"])) {
    if (row.metricKey !== "media_reach" || row.numericValue === null) continue;
    const publishedAt = parse<any>(row.metadataJson, {}).publishedAt;
    if (typeof publishedAt === "string") latest.set(row.scopeId, { publishedAt, reach: row.numericValue });
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------- read

export function getMediaPlan(db: DbClient, planId: string) {
  const repo = createMediaPlanRepository(db);
  const plan = repo.getPlan(planId);
  if (!plan) throw new NotFoundError("Media plan not found");
  const products = new Map(repo.readPlannerProducts().map((p) => [p.id, p]));
  return {
    ...plan,
    rationale: parse(plan.rationale, {}),
    items: repo.listItems(planId).map((item: any) => {
      const product = products.get(item.productId);
      const photoIds: string[] = parse(item.photoIdsJson, []);
      return {
        id: item.id, itemIndex: item.itemIndex, contentType: item.contentType, postFormat: item.postFormat, plannedAt: item.plannedAt, timeBasis: item.timeBasis,
        product: product ? { id: product.id, sku: product.sku, title: product.title, category: product.category } : { id: item.productId, sku: null, title: null, category: null },
        photos: photoIds.map((id) => ({ id, url: product?.photos.find((ph) => ph.id === id)?.url ?? null, hero: id === item.heroPhotoId })),
        heroPhotoId: item.heroPhotoId, caption: item.caption, hashtags: parse(item.hashtagsJson, []), hook: item.hook, frameTexts: parse(item.frameTextsJson, null), finalFrameText: item.finalFrameText,
        reel: item.contentType === "REEL" ? { status: item.reelAssetStatus, previewPath: item.reelAssetStatus === "RENDERED" ? `/api/media-planner/plans/${planId}/items/${item.id}/reel` : null } : null,
        rationale: item.rationale, status: item.status, version: item.version,
        socialChain: { socialContentId: item.socialContentId, preparedImageId: item.preparedImageId, approvalId: item.socialApprovalId, publishIntentId: item.publishIntentId, publishScheduleId: item.publishScheduleId },
      };
    }),
  };
}

export function getLatestMediaPlan(db: DbClient) {
  const latest = createMediaPlanRepository(db).latestPlan();
  return latest ? getMediaPlan(db, latest.id) : null;
}

// ---------------------------------------------------------------- generation

export async function renderPlanReel(db: DbClient, planId: string, itemId: string, deps: MediaPlannerDeps = {}) {
  const repo = createMediaPlanRepository(db);
  const plan = repo.getPlan(planId), item = repo.getItem(planId, itemId);
  if (!plan || !item || item.contentType !== "REEL") throw new NotFoundError("Reel plan item not found");
  if (!["DRAFT", "READY_FOR_REVIEW", "APPROVED"].includes(plan.status)) throw new ConflictError("Reel can only be rendered before scheduling");
  if (item.preparedImageId) throw new ConflictError("Reel asset is already registered with the Social Agent and cannot be re-rendered");
  const env = envOf(deps);
  if (!(await (deps.ffmpegAvailable ?? (() => isFfmpegAvailable(env)))())) { repo.patchItem(itemId, { reelAssetStatus: "RENDERER_UNAVAILABLE", reelAssetPath: null }); return getMediaPlan(db, planId); }
  const product = repo.readPlannerProducts().find((p) => p.id === item.productId);
  const photoPaths = parse<string[]>(item.photoIdsJson, []).map((id) => product?.photos.find((ph) => ph.id === id)?.url).map((url) => (url ? localPhotoPath(url) : null));
  if (!photoPaths.length || photoPaths.some((p) => !p)) { repo.patchItem(itemId, { reelAssetStatus: "RENDER_FAILED", reelAssetPath: null }); return getMediaPlan(db, planId); }
  const dir = mediaAssetDir(env);
  await mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, reelFileName(itemId));
  try {
    await (deps.render ?? renderReel)({ photoPaths: photoPaths as string[], outputPath, hookText: item.hook, finalText: item.finalFrameText, fontFile: env.REEL_FONT_FILE?.trim() || null }, { env });
    repo.patchItem(itemId, { reelAssetStatus: "RENDERED", reelAssetPath: outputPath, updatedAt: nowOf(deps).toISOString() });
  } catch {
    repo.patchItem(itemId, { reelAssetStatus: "RENDER_FAILED", reelAssetPath: null });
  }
  return getMediaPlan(db, planId);
}

export async function generateMediaPlan(db: DbClient, input: { generatedBy: string; startDate?: string }, deps: MediaPlannerDeps = {}) {
  const env = envOf(deps), now = nowOf(deps), timeZone = timezoneOf(env);
  const repo = createMediaPlanRepository(db);
  const eligible = eligibleProducts(repo.readPlannerProducts(), productPhotoStaticPath);
  const selection = selectPlanProducts(eligible);
  if ("blocker" in selection) throw new MediaPlanningBlockedError([selection.blocker]);
  if (input.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new BadRequestError("startDate must be YYYY-MM-DD");
  const dates = planDates(input.startDate ?? defaultStartDate(now, timeZone));
  const recommendation = recommendPostingHours(instagramEvidence(db), timeZone);

  type Draft = { key: string; product: EligibleProduct; kind: "feed" | "reel"; date: string; photoIds: string[] };
  const drafts: Draft[] = [
    ...selection.feed.map((product, i) => ({ key: `feed-${i}`, product, kind: "feed" as const, date: dates[i]!, photoIds: [product.photos[0]!.id] })),
    { key: "reel", product: selection.reel, kind: "reel" as const, date: dates[REEL_DAY_INDEX]!, photoIds: selection.reel.photos.slice(0, REEL_MAX_PHOTOS).map((p) => p.id) },
  ];
  const requests: MediaCopyRequestItem[] = drafts.map((d) => ({ key: d.key, kind: d.kind, plannedDate: d.date, photoCount: d.photoIds.length, product: { sku: d.product.sku, title: d.product.title, category: d.product.category, brand: d.product.brand, condition: d.product.condition } }));
  const provider = deps.copyProvider === undefined ? createConfiguredMediaCopyProvider(env) : deps.copyProvider;
  let copy: Record<string, PlanItemCopy>, copySource: string;
  try {
    if (!provider) throw new Error("NOT_CONFIGURED");
    copy = await provider.generate(requests);
    copySource = provider.source;
  } catch (error) {
    copy = await new DeterministicMediaCopyProvider().generate(requests);
    copySource = provider ? `deterministic_fallback:${error instanceof Error ? error.message.slice(0, 60) : "error"}` : "deterministic";
  }

  const planId = randomUUID(), t = now.toISOString();
  const categories = new Set(drafts.map((d) => d.product.category ?? "uncategorised"));
  repo.insertPlan(
    { id: planId, startDate: dates[0]!, endDate: dates[dates.length - 1]!, timezone: timeZone, status: "DRAFT", generatedAt: t, generatedBy: input.generatedBy, copySource, timeRecommendation: recommendation.basis,
      rationale: JSON.stringify({ selection: `${eligible.length} eligible products; ${FEED_POSTS} feed posts + 1 Reel over ${dates.length} days; ${categories.size} categories; no product repeated.`, time: recommendation.detail, format: "Feed posts are SINGLE_IMAGE: the Social Agent chain publishes one prepared image per post (carousel not supported yet).", reel: "Reel is rendered locally (ffmpeg) from real ERP photos and, after approval, published by the Social Agent chain as an Instagram Reel." }),
      createdAt: t, updatedAt: t },
    drafts.map((d, index) => {
      const c = copy[d.key]!;
      return {
        id: randomUUID(), planId, itemIndex: index, contentType: d.kind === "reel" ? "REEL" : "FEED_POST", postFormat: d.kind === "reel" ? "REEL" : "SINGLE_IMAGE", productId: d.product.id,
        photoIdsJson: JSON.stringify(d.photoIds), heroPhotoId: d.photoIds[0]!, plannedAt: slotFor(d.date, timeZone, recommendation, d.kind), timeBasis: recommendation.basis,
        caption: c.caption, hashtagsJson: JSON.stringify(c.hashtags), hook: c.hook, frameTextsJson: c.frameTexts ? JSON.stringify(c.frameTexts) : null, finalFrameText: c.finalFrameText,
        reelAssetStatus: d.kind === "reel" ? "PENDING" : null, rationale: c.rationale, status: "PROPOSED", createdAt: t, updatedAt: t,
      };
    }),
  );
  const reelItem = repo.listItems(planId).find((i: any) => i.contentType === "REEL");
  if (reelItem) await renderPlanReel(db, planId, reelItem.id, deps);
  repo.setPlanStatus(planId, ["DRAFT"], { status: "READY_FOR_REVIEW", updatedAt: nowOf(deps).toISOString() });
  return getMediaPlan(db, planId);
}

// ---------------------------------------------------------------- owner review

export function editMediaPlanItem(db: DbClient, planId: string, itemId: string, raw: unknown, deps: MediaPlannerDeps = {}) {
  const input = editPlanItemSchema.parse(raw);
  const repo = createMediaPlanRepository(db);
  const plan = repo.getPlan(planId), item = repo.getItem(planId, itemId);
  if (!plan || !item) throw new NotFoundError("Media plan item not found");
  if (plan.status !== "READY_FOR_REVIEW") throw new ConflictError("Only a plan awaiting review can be edited");
  const eligible = eligibleProducts(repo.readPlannerProducts(), productPhotoStaticPath);
  const productId = input.productId ?? item.productId;
  const product = eligible.find((p) => p.id === productId);
  if (!product) throw new BadRequestError("Selected product is not eligible (active, in stock, with ready photos)");
  const productChanged = productId !== item.productId;
  const photoIds = input.photoIds ?? (productChanged ? (item.contentType === "REEL" ? product.photos.slice(0, REEL_MAX_PHOTOS).map((p) => p.id) : [product.photos[0]!.id]) : parse<string[]>(item.photoIdsJson, []));
  if (photoIds.some((id) => !product.photos.some((p) => p.id === id))) throw new BadRequestError("Selected photos must be ready photos of the selected product");
  if (item.contentType === "FEED_POST" && photoIds.length !== 1) throw new BadRequestError("Feed posts publish one image (carousel publishing is not supported by the Social Agent chain yet)");
  const heroPhotoId = input.heroPhotoId ?? (photoIds.includes(item.heroPhotoId) ? item.heroPhotoId : photoIds[0]!);
  if (!photoIds.includes(heroPhotoId)) throw new BadRequestError("Hero photo must be one of the selected photos");
  if (input.plannedAt && Date.parse(input.plannedAt) <= nowOf(deps).getTime()) throw new BadRequestError("Posting time must be in the future");
  const visualChanged = productChanged || JSON.stringify(photoIds) !== item.photoIdsJson;
  const ok = repo.editItem(itemId, input.expectedVersion, {
    productId, photoIdsJson: JSON.stringify(photoIds), heroPhotoId,
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.hashtags !== undefined ? { hashtagsJson: JSON.stringify(input.hashtags) } : {}),
    ...(input.plannedAt !== undefined ? { plannedAt: new Date(input.plannedAt).toISOString(), timeBasis: "OWNER_EDITED" } : {}),
    ...(item.contentType === "REEL" && visualChanged ? { reelAssetStatus: "RENDER_REQUIRED", reelAssetPath: null } : {}),
    status: "EDITED", updatedAt: nowOf(deps).toISOString(),
  });
  if (!ok) throw new ConflictError("Plan item changed. Reload before editing.");
  return getMediaPlan(db, planId);
}

export function approveMediaPlan(db: DbClient, planId: string, actorId: string, deps: MediaPlannerDeps = {}) {
  const repo = createMediaPlanRepository(db);
  const plan = repo.getPlan(planId);
  if (!plan) throw new NotFoundError("Media plan not found");
  if (plan.status === "APPROVED" || plan.status === "SCHEDULED") return getMediaPlan(db, planId); // idempotent
  const t = nowOf(deps).toISOString();
  if (!repo.setPlanStatus(planId, ["READY_FOR_REVIEW"], { status: "APPROVED", approvedAt: t, approvedByAdminUserId: actorId, updatedAt: t })) throw new ConflictError("Only a plan awaiting review can be approved");
  return getMediaPlan(db, planId);
}

export function rejectMediaPlan(db: DbClient, planId: string, deps: MediaPlannerDeps = {}) {
  const repo = createMediaPlanRepository(db);
  if (!repo.getPlan(planId)) throw new NotFoundError("Media plan not found");
  const t = nowOf(deps).toISOString();
  if (!repo.setPlanStatus(planId, ["READY_FOR_REVIEW", "DRAFT"], { status: "REJECTED", rejectedAt: t, updatedAt: t })) throw new ConflictError("Only an unapproved plan can be rejected");
  return getMediaPlan(db, planId);
}

// ---------------------------------------------------------------- hand-off to the Social Agent chain

/**
 * Converts an APPROVED plan into existing social-chain records (resumable and idempotent): each
 * step is skipped when its id is already linked, and every chain request uses a deterministic
 * request id derived from the plan item, so a repeat call replays instead of duplicating.
 * Nothing here calls Instagram - the existing scheduler/executor publishes at the scheduled time.
 */
export async function scheduleMediaPlan(db: DbClient, planId: string, actorId: string, deps: MediaPlannerDeps = {}) {
  const repo = createMediaPlanRepository(db);
  const plan = repo.getPlan(planId);
  if (!plan) throw new NotFoundError("Media plan not found");
  if (plan.status !== "APPROVED" && plan.status !== "SCHEDULED") throw new ConflictError("Only an approved plan can be scheduled");
  const driver = driverOf(deps);
  const social = createSocialContentService(db, driver);
  const t = () => nowOf(deps).toISOString();

  for (const item of repo.listItems(planId)) {
    if (item.status === "SCHEDULED") continue;
    const isReel = item.contentType === "REEL";
    // Fail closed: a Reel is only handed off with its completed, valid rendered MP4 - never as an image post.
    if (isReel && (item.reelAssetStatus !== "RENDERED" || !item.reelAssetPath)) throw new ConflictError("Reel asset is not rendered; render the Reel before scheduling");

    const marker = `media-plan-item:${item.id}`;
    let contentId: string | null = item.socialContentId ?? repo.findSocialContentByConcept(marker);
    if (!contentId) {
      const hashtags: string[] = parse(item.hashtagsJson, []);
      const mediaIds = isReel ? parse<string[]>(item.photoIdsJson, []) : [item.heroPhotoId];
      const created = await social.create({ contentType: isReel ? "reel" : "post", caption: `${item.caption}\n\n${hashtags.join(" ")}`.slice(0, 2200), productId: item.productId, mediaIds, hashtags, concept: marker });
      contentId = created.id;
    }
    repo.patchItem(item.id, { socialContentId: contentId });

    let content = await social.get(contentId);
    if (content.status === "draft") content = await social.transition(contentId, { status: "ready_for_review", expectedVersion: content.version });

    let preparedImageId: string | null = item.preparedImageId;
    if (!preparedImageId) {
      const preparation = createSocialContentPreparationService(db, driver);
      preparedImageId = (isReel
        ? await preparation.prepareReel(contentId, item.heroPhotoId, item.reelAssetPath!)
        : await preparation.prepare(contentId, item.heroPhotoId, resolvePublicApiOrigin())).id;
      repo.patchItem(item.id, { preparedImageId });
    }

    const approvalRequestId = deterministicRequestId(item.id, "approval");
    let approvalId: string | null = item.socialApprovalId ?? repo.findApprovalByRequestId(approvalRequestId);
    if (!approvalId) {
      content = await social.get(contentId);
      approvalId = (await social.approve(contentId, { preparedImageId, expectedVersion: content.version, requestId: approvalRequestId }, actorId)).id;
    }
    repo.patchItem(item.id, { socialApprovalId: approvalId });

    const intent = await createSocialPublishIntentService(db, driver).create({ approvalId, requestId: deterministicRequestId(item.id, "intent") }, actorId);
    repo.patchItem(item.id, { publishIntentId: intent.id });
    const schedule = await createSocialPublishScheduleService(db, driver, () => nowOf(deps).getTime()).create({ publishIntentId: intent.id, requestId: deterministicRequestId(item.id, "schedule"), requestedPublicationAt: item.plannedAt }, actorId);
    repo.patchItem(item.id, { publishScheduleId: schedule.id, status: "SCHEDULED", updatedAt: t() });
  }
  // SCHEDULED only when every item - all 4 feed posts AND the Reel - is in the Social Agent schedule.
  if (repo.listItems(planId).every((i: any) => i.status === "SCHEDULED")) repo.setPlanStatus(planId, ["APPROVED"], { status: "SCHEDULED", scheduledAt: t(), updatedAt: t() });
  return getMediaPlan(db, planId);
}

// ---------------------------------------------------------------- pilot readiness (sanitized)

export async function getMediaPlannerReadiness(db: DbClient, deps: MediaPlannerDeps = {}) {
  const env = envOf(deps);
  const rows = createMediaPlanRepository(db).readPlannerProducts();
  const eligible = eligibleProducts(rows, productPhotoStaticPath);
  const instagram = await getInstagramPublishingReadiness(db, env).catch(() => null);
  const ffmpeg = resolveFfmpeg(env);
  const rendererReady = await (deps.ffmpegAvailable ?? (() => isFfmpegAvailable(env)))();
  // Durable asset directory: creatable and writable (Render: MEDIA_ASSET_DIR=/var/data/media-assets).
  const assetDir = mediaAssetDir(env);
  const assetDirWritable = await mkdir(assetDir, { recursive: true }).then(() => access(assetDir, fsConstants.W_OK)).then(() => true, () => false);
  // Instagram fetches video_url: PUBLIC_API_ORIGIN must be HTTPS and an allowed Instagram media host.
  let publicVideoDeliveryReady = false;
  try { validateInstagramMediaUrl(`${resolvePublicApiOrigin(env)}${REEL_PUBLIC_PATH}/${reelFileName("00000000-0000-4000-8000-000000000000")}`, env); publicVideoDeliveryReady = true; } catch { publicVideoDeliveryReady = false; }
  const plan = getLatestMediaPlan(db);
  const items: { contentType: string; status: string }[] = plan?.items ?? [];
  const feedScheduled = items.filter((i) => i.contentType === "FEED_POST" && i.status === "SCHEDULED").length;
  const reelScheduled = items.some((i) => i.contentType === "REEL" && i.status === "SCHEDULED");
  const technicalBlockers = [
    ...(eligible.length < MIN_ELIGIBLE_PRODUCTS ? [`INSUFFICIENT_ELIGIBLE_PRODUCTS:${eligible.length}/${MIN_ELIGIBLE_PRODUCTS}`] : []),
    ...(instagram?.ready ? [] : ["INSTAGRAM_PUBLISHING_NOT_READY"]),
    ...(rendererReady ? [] : ["REEL_RENDERER_UNAVAILABLE"]),
    ...(assetDirWritable ? [] : ["MEDIA_ASSET_DIR_NOT_WRITABLE"]),
    ...(publicVideoDeliveryReady ? [] : ["PUBLIC_VIDEO_DELIVERY_NOT_READY"]),
  ];
  const blockers = [
    ...technicalBlockers,
    ...(plan ? [] : ["NO_PLAN"]),
    ...(plan && !["APPROVED", "SCHEDULED"].includes(plan.status) ? [`PLAN_${plan.status}`] : []),
  ];
  return {
    eligibleProductCount: eligible.length,
    productsWithReadyPhotos: rows.filter((p) => p.photos.some((ph) => ph.processingStatus === "Ready")).length,
    requiredProductCount: MIN_ELIGIBLE_PRODUCTS,
    copyProvider: createConfiguredMediaCopyProvider(env) ? "openai" : "deterministic",
    instagramConnectionReady: instagram?.connection === "connected",
    instagramPublishingReady: Boolean(instagram?.ready),
    imagePublishingSupported: true,
    reelPublishingSupported: true,
    ffmpegAvailable: rendererReady,
    ffmpegSource: ffmpeg.source,
    reelTextOverlayConfigured: Boolean(env.REEL_FONT_FILE?.trim()),
    mediaAssetDirWritable: assetDirWritable,
    publicVideoDeliveryReady,
    planExists: Boolean(plan),
    planStatus: plan?.status ?? null,
    planApproved: Boolean(plan && ["APPROVED", "SCHEDULED"].includes(plan.status)),
    feedPostsScheduled: feedScheduled,
    reelScheduled,
    technicallyReady: technicalBlockers.length === 0,
    ready: blockers.length === 0,
    blockers,
  };
}
