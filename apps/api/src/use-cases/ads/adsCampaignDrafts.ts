import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as schema from "../../db/schema";
import { productPhotoStaticPath } from "../../services/photoStorage";
import type { AdsBudgetPolicy, AdsBudgetProposal } from "./adsBudgetGuard";
import type { AdsCampaignBrief } from "./adsCampaignBriefs";
import { readAdsDraftPlanForProduct } from "./adsDraftPlan";
import type { PaidProvider } from "./paidLaunchPreflight";

/**
 * ADS-008 Campaign Manager foundations - NON-EXECUTING. Builds a concrete, provider-specific
 * campaign draft from the existing ADS-004C plan (brief + budget guard) and real ERP product
 * photos, validates it, fingerprints it and evaluates whether an owner approval is bound to that
 * exact content. Nothing here creates, edits, activates or funds a provider campaign: provider
 * execution is disabled for every provider and no result ever authorizes spend.
 * Persistence of drafts/approvals/audit events needs a schema decision (see docs/ads/ADS-008).
 */

export interface ProviderCampaignCapability {
  readonly formats: readonly ("SINGLE_IMAGE" | "CAROUSEL")[];
  readonly maxImages: number;
  readonly headlineMaxChars: number;
  readonly primaryTextMaxChars: number;
  readonly minImageShortSidePx: number;
  readonly objectives: readonly "MARKETPLACE_TRAFFIC"[];
  readonly executionEnabled: false;
}
/**
 * Conservative PLANNING limits only; they must be re-verified against current provider
 * documentation and the connected account before any execution design.
 */
const PLANNING_CAPABILITIES: Record<PaidProvider, ProviderCampaignCapability> = {
  meta:{ formats: ["SINGLE_IMAGE", "CAROUSEL"], maxImages: 10, headlineMaxChars: 40, primaryTextMaxChars: 125, minImageShortSidePx: 600, objectives: ["MARKETPLACE_TRAFFIC"], executionEnabled: false },
  google_ads: { formats: ["SINGLE_IMAGE"], maxImages: 5, headlineMaxChars: 30, primaryTextMaxChars: 90, minImageShortSidePx: 300, objectives: ["MARKETPLACE_TRAFFIC"], executionEnabled: false },
  pinterest_ads: { formats: ["SINGLE_IMAGE"], maxImages: 1, headlineMaxChars: 100, primaryTextMaxChars: 500, minImageShortSidePx: 600, objectives: ["MARKETPLACE_TRAFFIC"], executionEnabled: false },
};
export const ADS_PROVIDER_CAPABILITIES = Object.freeze({ limitsSource: "PLANNING_DEFAULTS_UNVERIFIED" as const, ...PLANNING_CAPABILITIES });

export interface ErpPhotoFacts {
  readonly id: string; readonly url: string; readonly processingStatus: string;
  readonly isPrimary: boolean; readonly sortOrder: number; readonly width: number; readonly height: number;
}
export type MediaExclusion = "NOT_READY" | "NOT_ERP_HOSTED" | "TOO_SMALL" | "OVER_PROVIDER_LIMIT";

/** Only real, processed ERP product photos hosted by Noctella; primary first, then ERP order. */
export function selectCampaignCreativeMedia(photos: readonly ErpPhotoFacts[], provider: PaidProvider, hostedPrefix = productPhotoStaticPath) {
  const cap = ADS_PROVIDER_CAPABILITIES[provider];
  const excluded: { photoId: string; reason: MediaExclusion }[] = [];
  const eligible = [...photos].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).filter((p) => {
    const reason: MediaExclusion | null = p.processingStatus !== "Ready" ? "NOT_READY"
      : !p.url.startsWith(`${hostedPrefix}/`) ? "NOT_ERP_HOSTED"
      : Math.min(p.width, p.height) < cap.minImageShortSidePx ? "TOO_SMALL" : null;
    if (reason) excluded.push({ photoId: p.id, reason });
    return !reason;
  });
  for (const p of eligible.slice(cap.maxImages)) excluded.push({ photoId: p.id, reason: "OVER_PROVIDER_LIMIT" });
  return { selected: eligible.slice(0, cap.maxImages).map((p) => ({ photoId: p.id, url: p.url, width: p.width, height: p.height })), excluded };
}

/** Shortens at a word boundary; the shortening is always reported, never silent. */
function fit(text: string, max: number): { value: string; shortened: boolean } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return { value: clean, shortened: false };
  const cut = clean.slice(0, max - 1);
  return { value: `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length).trimEnd()}…`, shortened: true };
}

export function buildCampaignDraft(input: {
  readonly provider: PaidProvider; readonly brief: AdsCampaignBrief; readonly budget: AdsBudgetProposal;
  readonly media: ReturnType<typeof selectCampaignCreativeMedia>;
}) {
  const cap = ADS_PROVIDER_CAPABILITIES[input.provider];
  const headline = fit(input.brief.title, cap.headlineMaxChars);
  const primaryText = fit(input.brief.creativeBrief.hook, cap.primaryTextMaxChars);
  return {
    schemaVersion: 1 as const,
    provider: input.provider,
    productId: input.brief.productId,
    objective: input.brief.objective,
    destination: { marketplace: input.brief.destination, url: input.brief.marketplaceUrl },
    creative: {
      format: input.media.selected.length > 1 && cap.formats.includes("CAROUSEL") ? "CAROUSEL" as const : "SINGLE_IMAGE" as const,
      headline: headline.value, primaryText: primaryText.value, callToAction: input.brief.creativeBrief.callToAction,
      mediaPhotoIds: input.media.selected.map((m) => m.photoId),
      proofRequired: input.brief.creativeBrief.proofRequired,
    },
    // Recommendations only: keywords from existing Marketing Tags; no inferred demographics or
    // audiences, and no geography until the owner confirms shipping, consent and policy scope.
    targeting: { keywordHints: input.brief.keywordHints, categoryHint: input.brief.category, geography: null, demographics: null, ownerMustConfirm: true as const },
    budget: {
      currency: "EUR" as const, proposedDailyEur: input.budget.proposedDailyEur,
      hardDailyLimitEur: input.budget.hardDailyLimitEur, hardTotalLimitEur: input.budget.hardTotalLimitEur,
      guardDecision: input.budget.decision, guardBlockers: input.budget.blockers,
    },
    notes: [...(headline.shortened ? ["HEADLINE_SHORTENED"] : []), ...(primaryText.shortened ? ["PRIMARY_TEXT_SHORTENED"] : [])],
    status: "DRAFT" as const,
  };
}
export type CampaignDraft = ReturnType<typeof buildCampaignDraft>;

export type DraftValidationError = "NO_APPROVED_MEDIA" | "HEADLINE_TOO_LONG" | "PRIMARY_TEXT_TOO_LONG" | "TOO_MANY_IMAGES" | "FORMAT_UNSUPPORTED"
  | "OBJECTIVE_UNSUPPORTED" | "DESTINATION_NOT_MARKETPLACE" | "BUDGET_NOT_PROPOSED" | "BUDGET_BLOCKED" | "BUDGET_EXCEEDS_HARD_LIMIT";
export function validateCampaignDraft(draft: CampaignDraft) {
  const cap = ADS_PROVIDER_CAPABILITIES[draft.provider];
  const errors: DraftValidationError[] = [];
  if (!draft.creative.mediaPhotoIds.length) errors.push("NO_APPROVED_MEDIA");
  if (draft.creative.headline.length > cap.headlineMaxChars) errors.push("HEADLINE_TOO_LONG");
  if (draft.creative.primaryText.length > cap.primaryTextMaxChars) errors.push("PRIMARY_TEXT_TOO_LONG");
  if (draft.creative.mediaPhotoIds.length > cap.maxImages) errors.push("TOO_MANY_IMAGES");
  if (!cap.formats.includes(draft.creative.format)) errors.push("FORMAT_UNSUPPORTED");
  if (!cap.objectives.includes(draft.objective)) errors.push("OBJECTIVE_UNSUPPORTED");
  let host = "";
  try { const u = new URL(draft.destination.url); host = u.protocol === "https:" ? u.hostname : ""; } catch { host = ""; }
  if (!/(^|\.)ebay\.[a-z.]+$|(^|\.)etsy\.com$/.test(host)) errors.push("DESTINATION_NOT_MARKETPLACE");
  const b = draft.budget;
  if (b.proposedDailyEur === null) errors.push("BUDGET_NOT_PROPOSED");
  if (b.guardDecision === "BLOCKED") errors.push("BUDGET_BLOCKED");
  if (b.proposedDailyEur !== null && (b.proposedDailyEur > b.hardDailyLimitEur || b.proposedDailyEur > b.hardTotalLimitEur)) errors.push("BUDGET_EXCEEDS_HARD_LIMIT");
  return {
    valid: errors.length === 0, errors,
    // Even a valid draft can never be executed by this system today.
    executionBlockers: ["PROVIDER_EXECUTION_DISABLED", "NO_VERIFIED_PROVIDER_ACCOUNT_BINDING", "NO_LIVE_LISTING_REVALIDATION"] as const,
    executionEnabled: false as const, spendAuthorized: false as const,
  };
}

/** Deterministic content fingerprint: an approval is valid only for this exact draft content. */
export function campaignDraftFingerprint(draft: CampaignDraft): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(draft))).digest("hex");
}

export interface CampaignDraftApproval {
  readonly draftFingerprint: string; readonly approvedByAdminUserId: string; readonly approvedAt: string;
  readonly maxDailyEur: number; readonly maxTotalEur: number;
}
export type DraftApprovalStatus = "NOT_APPROVED" | "DRAFT_INVALID" | "APPROVAL_STALE" | "APPROVAL_EXPIRED" | "APPROVAL_INVALID" | "APPROVAL_EXCEEDED_BY_DRAFT" | "APPROVED_FOR_EXECUTION_REVIEW";
export const DRAFT_APPROVAL_MAX_AGE_HOURS = 24;
/**
 * Pure approval policy. A content change after approval makes it stale; old approvals expire;
 * the draft budget must sit inside the approved caps. The best outcome is still review-only.
 */
export function evaluateCampaignDraftApproval(draft: CampaignDraft, approval: CampaignDraftApproval | null, now = new Date()) {
  const base = { draftFingerprint: campaignDraftFingerprint(draft), executionAuthorized: false as const, spendAuthorized: false as const };
  const out = (status: DraftApprovalStatus) => ({ ...base, status });
  if (!validateCampaignDraft(draft).valid) return out("DRAFT_INVALID");
  if (!approval) return out("NOT_APPROVED");
  const approvedAt = Date.parse(approval.approvedAt);
  if (!approval.approvedByAdminUserId || !Number.isFinite(approvedAt) || approvedAt > now.getTime()
    || !(approval.maxDailyEur > 0) || !(approval.maxTotalEur > 0)) return out("APPROVAL_INVALID");
  if (approval.draftFingerprint !== base.draftFingerprint) return out("APPROVAL_STALE");
  if (now.getTime() - approvedAt > DRAFT_APPROVAL_MAX_AGE_HOURS * 3_600_000) return out("APPROVAL_EXPIRED");
  const b = draft.budget;
  if (b.proposedDailyEur === null || b.proposedDailyEur > approval.maxDailyEur || b.hardTotalLimitEur > approval.maxTotalEur) return out("APPROVAL_EXCEEDED_BY_DRAFT");
  return out("APPROVED_FOR_EXECUTION_REVIEW");
}

export type CampaignDraftAuditEventType = "DRAFT_PREVIEWED" | "DRAFT_APPROVED" | "DRAFT_REJECTED" | "APPROVAL_INVALIDATED";
/** Sanitized audit record (ids, fingerprint, EUR caps only - no tokens, no free text). Not persisted yet. */
export function buildCampaignDraftAuditEvent(type: CampaignDraftAuditEventType, draft: CampaignDraft, actorAdminUserId: string, now = new Date()) {
  return {
    eventType: type, at: now.toISOString(), actorAdminUserId,
    provider: draft.provider, productId: draft.productId, draftFingerprint: campaignDraftFingerprint(draft),
    safeMetadata: { mediaPhotoIds: draft.creative.mediaPhotoIds, proposedDailyEur: draft.budget.proposedDailyEur, hardDailyLimitEur: draft.budget.hardDailyLimitEur, hardTotalLimitEur: draft.budget.hardTotalLimitEur },
    executionAuthorized: false as const,
  };
}

/** Read-only preview: existing ADS-004C plan + real ERP photos -> provider drafts with validation. */
export async function readCampaignDraftPreview(db: DbClient, productId: string, provider: PaidProvider, policy: AdsBudgetPolicy, now = new Date()) {
  const plan = await readAdsDraftPlanForProduct(db, productId, policy, now);
  const photos = (db as any).select().from(schema.productPhotos).where(eq(schema.productPhotos.productId, productId)).orderBy(asc(schema.productPhotos.sortOrder)).all() as ErpPhotoFacts[];
  const media = selectCampaignCreativeMedia(photos, provider);
  const drafts = plan.campaignBriefs.map((brief) => {
    const draft = buildCampaignDraft({ provider, brief, budget: plan.budget, media });
    return { draft, validation: validateCampaignDraft(draft), approval: evaluateCampaignDraftApproval(draft, null, now), fingerprint: campaignDraftFingerprint(draft) };
  });
  return {
    productId, provider, generatedAt: now.toISOString(), scope: "DRAFT_PREVIEW_ONLY" as const,
    capability: ADS_PROVIDER_CAPABILITIES[provider], capabilityLimitsSource: ADS_PROVIDER_CAPABILITIES.limitsSource,
    media, drafts, exclusions: plan.exclusions, inventoryVerification: plan.inventoryVerification,
    ownerApprovalRecorded: false as const, executionEnabled: false as const, spendAuthorized: false as const,
  };
}
