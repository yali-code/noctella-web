import type { CampaignCandidate, CampaignCandidateProjection } from "./marketplaceCampaignCandidates";

/**
 * ADS-004A — deterministic, explainable campaign briefing over VERIFIED review candidates.
 * Does not infer buyer demographics, fabricate performance, generate provider audiences,
 * create campaigns, or authorize spending. AI copy is a separate optional reviewed step.
 */
export interface AdsCampaignBrief {
  readonly productId: string;
  readonly destination: "ebay" | "etsy";
  readonly marketplaceUrl: string;
  readonly title: string;
  readonly category: string | null;
  readonly keywordHints: readonly string[];
  readonly objective: "MARKETPLACE_TRAFFIC";
  readonly creativeBrief: {
    readonly hook: string;
    readonly proofRequired: readonly string[];
    readonly callToAction: "View the original listing";
  };
  readonly humanReviewRequired: true;
  readonly status: "DRAFT";
}
const safeText = (input: string, limit: number): string =>
  input.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
export function buildAdsCampaignBriefs(
  projection: CampaignCandidateProjection,
  options: { readonly maxBriefs?: number } = {},
): readonly AdsCampaignBrief[] {
  if (projection.spendAuthorized !== false || projection.requiresOwnerApproval !== true) return [];
  const max = options.maxBriefs ?? 20;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) return [];
  const candidates = projection.candidates
    .filter((item): item is CampaignCandidate => item.decision === "ELIGIBLE_FOR_REVIEW")
    .slice()
    .sort((a, b) => a.productId.localeCompare(b.productId)
      || a.destination.localeCompare(b.destination) || a.marketplaceUrl.localeCompare(b.marketplaceUrl));
  const briefs: AdsCampaignBrief[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (briefs.length >= max) break;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(candidate.productId)
      || (candidate.destination !== "ebay" && candidate.destination !== "etsy")
      || !candidate.marketplaceUrl.startsWith("https://")
      || !candidate.title.trim()) continue;
    const key = JSON.stringify([candidate.productId, candidate.destination, candidate.marketplaceUrl]);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = safeText(candidate.title, 110);
    if (!title) continue;
    briefs.push({
      productId: candidate.productId,
      destination: candidate.destination,
      marketplaceUrl: candidate.marketplaceUrl,
      title,
      category: candidate.category ? safeText(candidate.category, 70) : null,
      keywordHints: [...new Set(candidate.tagKeys.filter(x => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x)))].slice(0, 12),
      objective: "MARKETPLACE_TRAFFIC",
      creativeBrief: {
        hook: title,
        proofRequired: ["Use only actual product photos", "Verify condition claims against the listing", "Confirm stock and listing status immediately before launch"],
        callToAction: "View the original listing",
      },
      humanReviewRequired: true,
      status: "DRAFT",
    });
  }
  return briefs;
}
