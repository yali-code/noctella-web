import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Analytics Stage 3 PR-2: Knowledge Memory rules (pure). Learning = search -> verify -> extract ->
 * classify -> store with provenance -> compare -> update knowledge state -> use as context. Not
 * model training. External narrative never overrides measured Noctella data: every finding is
 * stored as requiring Noctella verification, and sentiment is never promoted to fact.
 */

export const TOPIC_DOMAINS = ["MARKETPLACE", "CATEGORY", "SOCIAL", "SOURCING", "RISK"] as const;
export const CLASSIFICATIONS = ["FACT", "OBSERVATION", "COMMUNITY_SENTIMENT", "HYPOTHESIS", "TREND_SIGNAL"] as const;
export const SOURCE_TYPES = ["official_documentation", "official_announcement", "specialist_publication", "industry_report", "community", "other"] as const;
export type SourceQuality = "A" | "B" | "C" | "D";
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Freshness = "CURRENT" | "AGING" | "STALE" | "SUPERSEDED" | "UNKNOWN";

/**
 * Configurable, testable source-quality rules: A authoritative/primary, B professional/specialist
 * (owner-curated list), C community signal, D weak/unverified. Community domains are checked first
 * so e.g. community.ebay.com is never treated as authoritative. Domain class alone is not trust:
 * classification and Noctella verification still apply.
 */
export interface SourceQualityRules { readonly authoritative: readonly string[]; readonly specialist: readonly string[]; readonly community: readonly string[] }
export const DEFAULT_SOURCE_QUALITY_RULES: SourceQualityRules = Object.freeze({
  authoritative: ["ebay.com", "etsy.com", "developers.facebook.com", "help.instagram.com", "business.instagram.com", "about.instagram.com", "about.fb.com", "developers.pinterest.com", "help.pinterest.com", "business.pinterest.com", "newsroom.pinterest.com"],
  specialist: [],
  community: ["reddit.com", "community.ebay.com", "community.etsy.com", "forums.ebay.com", "quora.com"],
});

const matches = (domain: string, list: readonly string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

export function sourceDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

export function classifySourceQuality(url: string, sourceType: (typeof SOURCE_TYPES)[number], rules: SourceQualityRules = DEFAULT_SOURCE_QUALITY_RULES): SourceQuality {
  const domain = sourceDomain(url);
  if (sourceType === "community" || matches(domain, rules.community)) return "C";
  if (matches(domain, rules.authoritative)) return "A";
  if (matches(domain, rules.specialist)) return "B";
  return "D";
}

/** Sentiment never becomes fact: community sources downgrade FACT to COMMUNITY_SENTIMENT, weak sources to HYPOTHESIS. */
export function guardClassification(requested: Classification, quality: SourceQuality): Classification {
  if (requested !== "FACT") return requested;
  if (quality === "C") return "COMMUNITY_SENTIMENT";
  if (quality === "D") return "HYPOTHESIS";
  return "FACT";
}

export function findingConfidence(quality: SourceQuality, classification: Classification): "HIGH" | "MEDIUM" | "LOW" {
  if (quality === "A" && classification === "FACT") return "HIGH";
  if (quality === "A" || quality === "B") return "MEDIUM";
  return "LOW";
}

/** Platform/policy/risk knowledge ages faster than category/sourcing/social knowledge. */
export const REVIEW_AFTER_DAYS: Readonly<Record<(typeof TOPIC_DOMAINS)[number], number>> = Object.freeze({ MARKETPLACE: 60, RISK: 60, SOCIAL: 90, CATEGORY: 90, SOURCING: 90 });

export function reviewBy(topicDomain: (typeof TOPIC_DOMAINS)[number], publishedAt: string | null, collectedAt: string): string {
  return new Date(Date.parse(publishedAt ?? collectedAt) + REVIEW_AFTER_DAYS[topicDomain] * 86_400_000).toISOString();
}

/** CURRENT until review date, AGING for 90 days after, then STALE. Undated sources are UNKNOWN. */
export function freshness(finding: { status: string; publishedAt: string | null; reviewBy: string }, now: Date): Freshness {
  if (finding.status === "SUPERSEDED") return "SUPERSEDED";
  if (!finding.publishedAt || !Number.isFinite(Date.parse(finding.reviewBy))) return "UNKNOWN";
  const review = Date.parse(finding.reviewBy);
  if (now.getTime() <= review) return "CURRENT";
  return now.getTime() <= review + 90 * 86_400_000 ? "AGING" : "STALE";
}

/** Twice-monthly cadence: H1 = days 1-15, H2 = day 16 to month end (UTC). */
export function researchPeriodKey(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-${now.getUTCDate() <= 15 ? "H1" : "H2"}`;
}

/** Minimise personal data: strip user handles, mentions and email addresses from excerpts. */
export function redactExcerpt(excerpt: string): string {
  return excerpt
    .replace(/\b[ur]\/[A-Za-z0-9_-]+/g, "[user]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(^|\s)@[A-Za-z0-9_.]{2,}/g, "$1[handle]")
    .slice(0, 500);
}

export function findingFingerprint(topicDomain: string, claim: string, sourceUrl: string): string {
  const normalizedUrl = (() => { const u = new URL(sourceUrl); u.hash = ""; return u.toString(); })();
  return createHash("sha256").update(`${topicDomain}|${claim.trim().toLowerCase().replace(/\s+/g, " ")}|${normalizedUrl}`).digest("hex");
}

export const findingCandidateSchema = z
  .object({
    topicDomain: z.enum(TOPIC_DOMAINS),
    topic: z.string().trim().min(2).max(200),
    claim: z.string().trim().min(10).max(1000),
    classification: z.enum(CLASSIFICATIONS),
    sourceUrl: z.string().url().refine((u) => u.startsWith("https://"), "https source required"),
    sourceType: z.enum(SOURCE_TYPES),
    publishedAt: z.string().datetime().optional(),
    excerpt: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    brand: z.string().max(100).optional(),
    productId: z.string().max(100).optional(),
    platform: z.string().max(40).optional(),
    businessRelevance: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
    relation: z.object({ type: z.enum(["supersedes", "conflicts"]), findingId: z.string().min(1) }).strict().optional(),
  })
  .strict();
export type FindingCandidate = z.infer<typeof findingCandidateSchema>;

/** Research topics for the twice-monthly run (Economy Mode: fixed list, no open crawling). */
export const RESEARCH_TOPICS: readonly { readonly domain: (typeof TOPIC_DOMAINS)[number]; readonly topic: string }[] = Object.freeze([
  ...["eBay seller policy, search and fees", "Etsy seller policy, search and fees", "Instagram/Meta platform changes", "Pinterest platform changes"].map((topic) => ({ domain: "MARKETPLACE" as const, topic })),
  ...["vintage cameras", "compact digital cameras", "film cameras", "lenses", "pens", "watches", "diecast/model cars", "vintage electronics", "porcelain", "pins/badges", "collectibles"].map((topic) => ({ domain: "CATEGORY" as const, topic })),
  ...["collector content behavior", "format trends", "visual/content trends"].map((topic) => ({ domain: "SOCIAL" as const, topic })),
  ...["auction trends", "supply/demand observations", "sourcing channel developments"].map((topic) => ({ domain: "SOURCING" as const, topic })),
  ...["fees", "policies", "shipping/customs", "API changes", "deprecations"].map((topic) => ({ domain: "RISK" as const, topic })),
]);

/** Research provider seam - no provider ships with Noctella yet (WEB SEARCH PROVIDER ACTIVATION REQUIRED). */
export interface ResearchProvider {
  readonly name: string;
  research(plan: { periodKey: string; topics: typeof RESEARCH_TOPICS }): Promise<FindingCandidate[]>;
}
