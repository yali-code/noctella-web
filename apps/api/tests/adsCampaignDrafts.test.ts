// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AdsBudgetProposal } from "../src/use-cases/ads/adsBudgetGuard";
import type { AdsCampaignBrief } from "../src/use-cases/ads/adsCampaignBriefs";
import {
  ADS_PROVIDER_CAPABILITIES, buildCampaignDraft, buildCampaignDraftAuditEvent, campaignDraftFingerprint, evaluateCampaignDraftApproval,
  selectCampaignCreativeMedia, validateCampaignDraft, type ErpPhotoFacts,
} from "../src/use-cases/ads/adsCampaignDrafts";

/** ADS-008: fixtures shaped like real ERP products/briefs; nothing executes or reaches a provider. */
const brief: AdsCampaignBrief = {
  productId: "NOC-000007", destination: "ebay", marketplaceUrl: "https://www.ebay.de/itm/123456789012", title: "Vintage Olympus OM-1 35mm SLR camera body",
  category: "Cameras", keywordHints: ["olympus", "om-1", "film camera"], objective: "MARKETPLACE_TRAFFIC",
  creativeBrief: { hook: "Original Olympus OM-1 body, as photographed.", proofRequired: ["Use only actual product photos"], callToAction: "View the original listing" },
  humanReviewRequired: true, status: "DRAFT",
};
const budget: AdsBudgetProposal = {
  productId: "NOC-000007", currency: "EUR", proposedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20, decision: "NEEDS_HUMAN_REVIEW", blockers: [],
  evidence: { landedCostEur: 40, historicalProfitEur: 25, profitStatus: "PROFITABLE" as AdsBudgetProposal["evidence"]["profitStatus"] }, requiresOwnerApproval: true, spendAuthorized: false,
};
const photo = (id: string, o: Partial<ErpPhotoFacts> = {}): ErpPhotoFacts => ({ id, url: `/images/product-photos/${id}.webp`, processingStatus: "Ready", isPrimary: false, sortOrder: 1, width: 1600, height: 1200, ...o });
const photos = [photo("p2", { sortOrder: 2 }), photo("p1", { isPrimary: true, sortOrder: 5 }), photo("pending", { processingStatus: "Pending" }), photo("ext", { url: "https://cdn.example.com/x.jpg" }), photo("small", { width: 400, height: 300 })];
const draftFor = (provider: "meta" | "google_ads" | "pinterest_ads" = "meta", b: AdsBudgetProposal = budget, br: AdsCampaignBrief = brief) =>
  buildCampaignDraft({ provider, brief: br, budget: b, media: selectCampaignCreativeMedia(photos, provider) });

describe("ADS-008 creative selection from approved ERP media", () => {
  it("uses only Ready, ERP-hosted, large-enough photos - primary first - within provider limits", () => {
    expect(selectCampaignCreativeMedia(photos, "meta")).toEqual({
      selected: [{ photoId: "p1", url: "/images/product-photos/p1.webp", width: 1600, height: 1200 }, { photoId: "p2", url: "/images/product-photos/p2.webp", width: 1600, height: 1200 }],
      excluded: [{ photoId: "ext", reason: "NOT_ERP_HOSTED" }, { photoId: "pending", reason: "NOT_READY" }, { photoId: "small", reason: "TOO_SMALL" }],
    });
    const pin = selectCampaignCreativeMedia(photos, "pinterest_ads");
    expect(pin.selected.map((m) => m.photoId)).toEqual(["p1"]);
    expect(pin.excluded).toContainEqual({ photoId: "p2", reason: "OVER_PROVIDER_LIMIT" });
    // Google's planning minimum is lower, so the 400x300 photo qualifies there.
    expect(selectCampaignCreativeMedia(photos, "google_ads").selected.map((m) => m.photoId)).toEqual(["p1", "small", "p2"]);
  });
});

describe("ADS-008 campaign draft model and validation", () => {
  it("builds a provider draft from the existing brief and budget guard, with targeting as owner-confirmed hints only", () => {
    const d = draftFor();
    expect(d).toMatchObject({
      provider: "meta", productId: "NOC-000007", objective: "MARKETPLACE_TRAFFIC", status: "DRAFT",
      destination: { marketplace: "ebay", url: "https://www.ebay.de/itm/123456789012" },
      creative: { format: "CAROUSEL", headline: "Vintage Olympus OM-1 35mm SLR camera…", mediaPhotoIds: ["p1", "p2"] },
      targeting: { keywordHints: ["olympus", "om-1", "film camera"], geography: null, demographics: null, ownerMustConfirm: true },
      budget: { currency: "EUR", proposedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20 },
      notes: ["HEADLINE_SHORTENED"],
    });
    expect(d.creative.headline.length).toBeLessThanOrEqual(ADS_PROVIDER_CAPABILITIES.meta.headlineMaxChars);
    expect(validateCampaignDraft(d)).toMatchObject({ valid: true, errors: [], executionEnabled: false, spendAuthorized: false });
    expect(validateCampaignDraft(d).executionBlockers).toContain("PROVIDER_EXECUTION_DISABLED");
  });

  it("rejects missing media, blocked or missing budget and non-marketplace destinations", () => {
    const noMedia = buildCampaignDraft({ provider: "meta", brief, budget, media: selectCampaignCreativeMedia([photo("x", { processingStatus: "Failed" })], "meta") });
    expect(validateCampaignDraft(noMedia).errors).toContain("NO_APPROVED_MEDIA");
    expect(validateCampaignDraft(draftFor("meta", { ...budget, decision: "BLOCKED", proposedDailyEur: null, blockers: ["NO_FINANCIAL_EVIDENCE"] as AdsBudgetProposal["blockers"] })).errors).toEqual(["BUDGET_NOT_PROPOSED", "BUDGET_BLOCKED"]);
    expect(validateCampaignDraft(draftFor("meta", { ...budget, proposedDailyEur: 9 })).errors).toEqual(["BUDGET_EXCEEDS_HARD_LIMIT"]);
    for (const url of ["http://www.ebay.de/itm/1", "https://evil.example.com/ebay.de", "javascript:alert(1)"]) {
      expect(validateCampaignDraft(draftFor("meta", budget, { ...brief, marketplaceUrl: url })).errors).toContain("DESTINATION_NOT_MARKETPLACE");
    }
    expect(validateCampaignDraft(draftFor("meta", budget, { ...brief, destination: "etsy", marketplaceUrl: "https://www.etsy.com/listing/1" })).valid).toBe(true);
  });
});

describe("ADS-008 explicit approval binding and audit trail", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const approve = (d = draftFor(), o: Record<string, unknown> = {}) => ({ draftFingerprint: campaignDraftFingerprint(d), approvedByAdminUserId: "owner-1", approvedAt: "2026-10-10T10:00:00.000Z", maxDailyEur: 5, maxTotalEur: 20, ...o });

  it("fingerprints content deterministically and binds approval to that exact content", () => {
    const d = draftFor();
    expect(campaignDraftFingerprint(d)).toMatch(/^[0-9a-f]{64}$/);
    expect(campaignDraftFingerprint(draftFor())).toBe(campaignDraftFingerprint(d));
    expect(evaluateCampaignDraftApproval(d, approve(d), now)).toMatchObject({ status: "APPROVED_FOR_EXECUTION_REVIEW", executionAuthorized: false, spendAuthorized: false });
    const edited = { ...d, creative: { ...d.creative, headline: "Edited after approval" } };
    expect(evaluateCampaignDraftApproval(edited, approve(d), now).status).toBe("APPROVAL_STALE");
  });

  it("fails closed for missing, invalid, expired or exceeded approvals and invalid drafts", () => {
    const d = draftFor();
    expect(evaluateCampaignDraftApproval(d, null, now).status).toBe("NOT_APPROVED");
    expect(evaluateCampaignDraftApproval(d, approve(d, { approvedByAdminUserId: "" }), now).status).toBe("APPROVAL_INVALID");
    expect(evaluateCampaignDraftApproval(d, approve(d, { approvedAt: "2026-10-11T00:00:00.000Z" }), now).status).toBe("APPROVAL_INVALID");
    expect(evaluateCampaignDraftApproval(d, approve(d, { approvedAt: "2026-10-09T09:00:00.000Z" }), now).status).toBe("APPROVAL_EXPIRED");
    expect(evaluateCampaignDraftApproval(d, approve(d, { maxDailyEur: 1 }), now).status).toBe("APPROVAL_EXCEEDED_BY_DRAFT");
    expect(evaluateCampaignDraftApproval(d, approve(d, { maxTotalEur: 10 }), now).status).toBe("APPROVAL_EXCEEDED_BY_DRAFT");
    const invalid = draftFor("meta", { ...budget, decision: "BLOCKED" });
    expect(evaluateCampaignDraftApproval(invalid, approve(invalid), now).status).toBe("DRAFT_INVALID");
  });

  it("produces sanitized audit events without free text or secrets", () => {
    const event = buildCampaignDraftAuditEvent("DRAFT_APPROVED", draftFor(), "owner-1", now);
    expect(event).toEqual({
      eventType: "DRAFT_APPROVED", at: now.toISOString(), actorAdminUserId: "owner-1", provider: "meta", productId: "NOC-000007",
      draftFingerprint: campaignDraftFingerprint(draftFor()), executionAuthorized: false,
      safeMetadata: { mediaPhotoIds: ["p1", "p2"], proposedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20 },
    });
    expect(JSON.stringify(event)).not.toMatch(/token|secret|password|headline/i);
  });

  it("keeps provider execution disabled for every provider", () => {
    for (const p of ["meta", "google_ads", "pinterest_ads"] as const) expect(ADS_PROVIDER_CAPABILITIES[p].executionEnabled).toBe(false);
    expect(ADS_PROVIDER_CAPABILITIES.limitsSource).toBe("PLANNING_DEFAULTS_UNVERIFIED");
  });
});
