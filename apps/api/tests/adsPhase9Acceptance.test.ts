// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { MetaPaidCampaignClient } from "../src/integrations/ads/metaPaidCampaignClient";
import { collectPaidCampaignEvidence } from "../src/services/paidAdsCollection";
import { readPaidCampaignReport } from "../src/use-cases/ads/adsPaidCampaignRead";
import { readPaidCampaignIntelligence } from "../src/use-cases/ads/adsIntelligence";
import { reconcilePaidSpend, type VerifiedPaidBillingEvidence } from "../src/use-cases/ads/paidSpendReconciliation";
import { buildCampaignDraft, evaluateCampaignDraftApproval, campaignDraftFingerprint, selectCampaignCreativeMedia } from "../src/use-cases/ads/adsCampaignDrafts";
import type { PaidCampaignQuery } from "../src/use-cases/ads/paidCampaignCollectorContract";

/**
 * ADS-009 cross-module ACCEPTANCE (code level, mocks + in-memory SQLite only):
 * mock Meta Graph -> collector -> analytics tables -> report reader -> Ads Intelligence ->
 * spend reconciliation, plus campaign-draft approval isolation. This is NOT operational proof:
 * no provider account, campaign, billing statement or deployment is exercised.
 */
const ACCOUNT = "3095361257478763", CAMPAIGN = "120210000000000001", TZ = "Europe/Sofia";
const TOKEN = "acceptance-fixture-token-never-real-0001";
const access = { accessToken: TOKEN };
const NOW = new Date("2026-09-30T12:00:00.000Z");
// Four consecutive 7-day windows (account-local dates); the last one spends 3x.
const WEEKS = [["2026-08-25", "2026-08-31", "70.00"], ["2026-09-01", "2026-09-07", "70.00"], ["2026-09-08", "2026-09-14", "70.00"], ["2026-09-15", "2026-09-21", "210.00"]] as const;
const query = (i: number): PaidCampaignQuery => ({ provider: "meta", accountId: ACCOUNT, campaignId: CAMPAIGN, startDate: WEEKS[i]![0], endDate: WEEKS[i]![1] });

type Mode = { spend?: string; status?: number; body?: unknown; account?: string };
function meta(mode: Mode = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    if (mode.status) return new Response(JSON.stringify(mode.body ?? {}), { status: mode.status });
    if (!url.pathname.endsWith("/insights")) return new Response(JSON.stringify({ account_id: mode.account ?? ACCOUNT, currency: "EUR", timezone_name: TZ }), { status: 200 });
    const range = JSON.parse(url.searchParams.get("time_range")!) as { since: string; until: string };
    const week = WEEKS.find((w) => w[0] === range.since)!;
    return new Response(JSON.stringify({ data: [{ campaign_id: CAMPAIGN, date_start: range.since, date_stop: range.until, spend: mode.spend ?? week[2], impressions: "7000", clicks: "140" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const write = { explicitReadApproval: true, explicitSnapshotWriteApproval: true, now: NOW };
async function collectAll(db: ReturnType<typeof createTestDb>) {
  const http = meta();
  for (let i = 0; i < WEEKS.length; i += 1) await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(http.fetchImpl), query(i), access, write);
  return http;
}
const dbDump = (db: ReturnType<typeof createTestDb>) => JSON.stringify(db.all(sql`SELECT * FROM analytics_runs`)) + JSON.stringify(db.all(sql`SELECT * FROM analytics_metric_snapshots`));

describe("ADS-009 acceptance: read-only collection -> provenance -> intelligence -> reconciliation", () => {
  it("collects four account-local windows read-only and reports the newest with full provenance", async () => {
    const db = createTestDb();
    const http = await collectAll(db);
    expect(http.calls.every((c) => (c.init.method ?? "GET") === "GET" && c.url.hostname === "graph.facebook.com")).toBe(true);
    const report = await readPaidCampaignReport(db, "meta", CAMPAIGN);
    // Sofia is UTC+3 in September: local 2026-09-15 00:00 .. 2026-09-22 00:00.
    expect(report).toMatchObject({ status: "REPORT_AVAILABLE", accountId: ACCOUNT, period: { start: "2026-09-14T21:00:00.000Z", end: "2026-09-21T21:00:00.000Z" },
      evidence: { spendEur: 210, reportedRoas: null, marketplaceConfirmedOrders: null }, marketplaceAttributionVerified: false, spendAuthorized: false });
  });

  it("feeds Ads Intelligence with every trusted window and flags the spend spike as advisory only", async () => {
    const db = createTestDb();
    await collectAll(db);
    const intel = await readPaidCampaignIntelligence(db, "meta", CAMPAIGN);
    expect(intel.windows).toHaveLength(4);
    expect(intel.dataQuality).toEqual({ untrustedWindows: 0, overlappingWindowsExcluded: 0 });
    expect(intel.anomalies.map((a) => a.code)).toEqual(["SPEND_SPIKE", "CPC_SPIKE"]);
    expect(intel).toMatchObject({ eligibleForAutomaticAction: false, budgetChangeEur: null, spendAuthorized: false, marketplaceRoas: null, organicMetricsIncluded: false });
  });

  it("reconciles only against finalized billing for the same account, campaign and account-local window", async () => {
    const db = createTestDb();
    await collectAll(db);
    const report = await readPaidCampaignReport(db, "meta", CAMPAIGN);
    const period = { start: "2026-09-14T21:00:00.000Z", end: "2026-09-21T21:00:00.000Z" };
    const billing: VerifiedPaidBillingEvidence = { provider: "meta", accountId: ACCOUNT, campaignId: CAMPAIGN, currency: "EUR", period, comparableAdSpendEur: 210, adSpendOnly: true, fromVerifiedProviderBilling: true, settlementFinal: true, sourceReference: "fixture-statement" };
    const base = { provider: "meta" as const, accountId: ACCOUNT, campaignId: CAMPAIGN, reportWindow: period, report, billing };
    expect(reconcilePaidSpend(base)).toMatchObject({ status: "RECONCILED_FOR_REVIEW", spendAuthorized: false, eligibleForAutomaticBudgetChange: false, independentlyVerifiedMarketplaceRevenueEur: null });
    const utcDays = { start: "2026-09-15T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" };
    expect(reconcilePaidSpend({ ...base, reportWindow: utcDays, billing: { ...billing, period: utcDays } }).status).toBe("SCOPE_MISMATCH");
    expect(reconcilePaidSpend({ ...base, accountId: "1111111111", billing: { ...billing, accountId: "1111111111" } }).status).toBe("SCOPE_MISMATCH");
    expect(reconcilePaidSpend({ ...base, billing: { ...billing, settlementFinal: false } }).status).toBe("UNSETTLED");
    expect(reconcilePaidSpend({ ...base, billing: null }).status).toBe("MISSING_BILLING");
  });
});

describe("ADS-009 acceptance: duplicates, retries, provider failures and secret redaction", () => {
  it("replays an identical window idempotently and fails closed on a provider restatement", async () => {
    const db = createTestDb();
    await collectAll(db);
    const count = () => (db.all(sql`SELECT count(*) AS n FROM analytics_metric_snapshots`) as { n: number }[])[0]!.n;
    const before = count();
    const replay = await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(meta().fetchImpl), query(3), access, write);
    expect(replay).toMatchObject({ status: "STORED", replayed: true });
    await expect(collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(meta({ spend: "199.99" }).fetchImpl), query(3), access, write)).rejects.toMatchObject({ code: "PAID_PROVIDER_RESTATEMENT" });
    expect(count()).toBe(before);
    expect((await readPaidCampaignReport(db, "meta", CAMPAIGN)).evidence?.spendEur).toBe(210);
  });

  it("stores nothing on throttling, expired token, permission denial or malformed responses", async () => {
    for (const [mode, kind] of [
      [{ status: 429 }, "rate_limit"], [{ status: 400, body: { error: { code: 190, message: `expired ${TOKEN}` } } }, "authentication"],
      [{ status: 400, body: { error: { code: 17 } } }, "rate_limit"], [{ status: 403 }, "permission"], [{ status: 500 }, "temporary"],
    ] as const) {
      const db = createTestDb();
      const error = await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(meta(mode).fetchImpl), query(0), access, write).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "PaidProviderReadError", kind });
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect((await readPaidCampaignReport(db, "meta", CAMPAIGN)).status).toBe("NOT_COLLECTED");
    }
  });

  it("never persists or returns the provider token", async () => {
    const db = createTestDb();
    await collectAll(db);
    const outputs = JSON.stringify([await readPaidCampaignReport(db, "meta", CAMPAIGN), await readPaidCampaignIntelligence(db, "meta", CAMPAIGN)]);
    expect(dbDump(db) + outputs).not.toContain(TOKEN);
  });
});

describe("ADS-009 acceptance: campaign approval isolation and migration safety", () => {
  it("draft approval never authorizes execution and never touches analytics evidence", async () => {
    const db = createTestDb();
    await collectAll(db);
    const before = dbDump(db);
    const media = selectCampaignCreativeMedia([{ id: "p1", url: "/images/product-photos/p1.webp", processingStatus: "Ready", isPrimary: true, sortOrder: 0, width: 1200, height: 1200 }], "meta");
    const draft = buildCampaignDraft({ provider: "meta", media,
      brief: { productId: "NOC-000007", destination: "ebay", marketplaceUrl: "https://www.ebay.de/itm/1", title: "Olympus OM-1", category: "Cameras", keywordHints: ["olympus"], objective: "MARKETPLACE_TRAFFIC", creativeBrief: { hook: "As photographed.", proofRequired: [], callToAction: "View the original listing" }, humanReviewRequired: true, status: "DRAFT" },
      budget: { productId: "NOC-000007", currency: "EUR", proposedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20, decision: "NEEDS_HUMAN_REVIEW", blockers: [], evidence: { landedCostEur: null, historicalProfitEur: null, profitStatus: "UNKNOWN" }, requiresOwnerApproval: true, spendAuthorized: false } });
    const approval = evaluateCampaignDraftApproval(draft, { draftFingerprint: campaignDraftFingerprint(draft), approvedByAdminUserId: "owner", approvedAt: "2026-09-30T11:00:00.000Z", maxDailyEur: 5, maxTotalEur: 20 }, NOW);
    expect(approval).toMatchObject({ status: "APPROVED_FOR_EXECUTION_REVIEW", executionAuthorized: false, spendAuthorized: false });
    expect(dbDump(db)).toBe(before);
  });

  it("Phase 6-8 add no schema: no ads-owned tables, paid data only in the existing analytics store", async () => {
    const db = createTestDb();
    await collectAll(db);
    expect(db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'ads%' OR name LIKE 'paid%')`)).toEqual([]);
    const namespaces = db.all(sql`SELECT DISTINCT metric_namespace AS ns, scope_type AS scope FROM analytics_metric_snapshots`);
    expect(namespaces).toEqual([{ ns: "paid_meta", scope: "external_ad_campaign" }]);
  });
});

describe("ADS-009 acceptance: ad-account identity across collection, intelligence and reconciliation", () => {
  it("quarantines a campaign history collected from two ad accounts and refuses cross-account reconciliation", async () => {
    const db = createTestDb();
    const a = meta();
    for (let i = 0; i < 3; i += 1) await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(a.fetchImpl), query(i), access, write);
    const OTHER = "5555555555";
    const b = meta({ account: OTHER });
    await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(b.fetchImpl), { ...query(3), accountId: OTHER }, access, write);
    const intel = await readPaidCampaignIntelligence(db, "meta", CAMPAIGN);
    expect(intel).toMatchObject({ status: "ACCOUNT_CONFLICT", windows: [], trend: null, anomalies: [], spendAuthorized: false });
    expect(intel.accountConflict).toEqual([{ accountId: ACCOUNT, windows: 3 }, { accountId: OTHER, windows: 1 }]);
    const report = await readPaidCampaignReport(db, "meta", CAMPAIGN);
    const period = { start: "2026-09-14T21:00:00.000Z", end: "2026-09-21T21:00:00.000Z" };
    const billing: VerifiedPaidBillingEvidence = { provider: "meta", accountId: ACCOUNT, campaignId: CAMPAIGN, currency: "EUR", period, comparableAdSpendEur: 210, adSpendOnly: true, fromVerifiedProviderBilling: true, settlementFinal: true, sourceReference: "fixture-statement" };
    // The newest stored window belongs to OTHER: billing for ACCOUNT can never reconcile against it.
    expect(reconcilePaidSpend({ provider: "meta", accountId: ACCOUNT, campaignId: CAMPAIGN, reportWindow: period, report, billing }).status).toBe("SCOPE_MISMATCH");
  });
});

describe("ADS-009 acceptance: ERP source data -> approved media -> campaign draft (non-executing)", () => {
  const PREVIEW_NOW = new Date("2026-09-30T12:00:00.000Z");
  async function seedErpProduct(db: ReturnType<typeof createTestDb>, listingUrl = "https://www.ebay.de/itm/123456789012") {
    const schema = await import("../src/db/schema.sqlite");
    db.insert(schema.categories).values({ id: "cat-cam", name: "Cameras", slug: "cameras" }).run();
    db.insert(schema.products).values({ id: "NOC-000007", sku: "NOC-000007", title: "Vintage Olympus OM-1 35mm SLR camera body", slug: "olympus-om-1", type: "unique_item", status: "published", stockQuantity: 1, categoryId: "cat-cam", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }).run();
    for (const [id, ready, primary, w] of [["ph-1", "Ready", true, 1600], ["ph-2", "Ready", false, 1600], ["ph-3", "Pending", false, 1600], ["ph-4", "Ready", false, 320]] as const) {
      db.insert(schema.productPhotos).values({ id, productId: "NOC-000007", processingStatus: ready, url: `/images/product-photos/${id}.webp`, thumbnailUrl: `/t/${id}.webp`, filename: `${id}.webp`, mimeType: "image/webp", sizeBytes: 10, width: w, height: w, isPrimary: primary, sortOrder: id === "ph-1" ? 0 : 1 }).run();
    }
    db.insert(schema.marketplaceConnections).values({ id: "conn-ebay", channel: "ebay", accountLabel: "ebay", status: "connected" }).run();
    db.insert(schema.externalListings).values({ id: "xl-1", productId: "NOC-000007", channel: "ebay", connectionId: "conn-ebay", externalListingId: "123456789012", externalListingUrl: listingUrl, externalStatus: "active", payloadSnapshot: "{}", publishedAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-30T08:00:00.000Z" }).run();
    db.insert(schema.marketplaceInventorySnapshots).values({ id: "snap-1", channel: "ebay", productId: "NOC-000007", externalListingId: "123456789012", localStock: 1, marketplaceStock: 1, capturedAt: "2026-09-30T09:00:00.000Z" }).run();
    const { addProductMarketingTag } = await import("../src/services/marketingTags");
    await addProductMarketingTag(db, "NOC-000007", "Film Camera");
  }

  it("builds a provider draft only from Ready ERP-hosted photos and fails closed without financial evidence", async () => {
    const db = createTestDb();
    await seedErpProduct(db);
    const { readCampaignDraftPreview } = await import("../src/use-cases/ads/adsCampaignDrafts");
    const before = dbDump(db);
    const preview = await readCampaignDraftPreview(db, "NOC-000007", "meta", { requestedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20 }, PREVIEW_NOW);
    expect(preview).toMatchObject({ scope: "DRAFT_PREVIEW_ONLY", ownerApprovalRecorded: false, executionEnabled: false, spendAuthorized: false, capabilityLimitsSource: "PLANNING_DEFAULTS_UNVERIFIED" });
    expect(preview.media.selected.map((m) => m.photoId)).toEqual(["ph-1", "ph-2"]);
    expect(preview.media.excluded).toEqual(expect.arrayContaining([{ photoId: "ph-3", reason: "NOT_READY" }, { photoId: "ph-4", reason: "TOO_SMALL" }]));
    expect(preview.drafts).toHaveLength(1);
    const [{ draft, validation, approval }] = preview.drafts;
    expect(draft).toMatchObject({ productId: "NOC-000007", destination: { marketplace: "ebay", url: "https://www.ebay.de/itm/123456789012" }, creative: { mediaPhotoIds: ["ph-1", "ph-2"] }, targeting: { demographics: null, geography: null } });
    // An unsold original has no historical profit: the existing budget guard blocks, so the draft is invalid and cannot be approved.
    expect(validation.errors).toContain("BUDGET_BLOCKED");
    expect(approval).toMatchObject({ status: "DRAFT_INVALID", executionAuthorized: false, spendAuthorized: false });
    expect(dbDump(db)).toBe(before);
  });

  it("never yields a valid draft for a lookalike marketplace URL stored on the ERP listing", async () => {
    for (const url of ["https://www.ebay.de.attacker.com/itm/123456789012", "https://www.ebay.de:8443/itm/123456789012", "http://www.ebay.de/itm/123456789012"]) {
      const db = createTestDb();
      await seedErpProduct(db, url);
      const { readCampaignDraftPreview } = await import("../src/use-cases/ads/adsCampaignDrafts");
      const preview = await readCampaignDraftPreview(db, "NOC-000007", "meta", { requestedDailyEur: 2, hardDailyLimitEur: 5, hardTotalLimitEur: 20 }, PREVIEW_NOW);

      // Layer 1: the existing ERP funnel policy (ADS-002A) already excludes the listing, so no draft
      // is built. Layer 2 (#351 exact-domain validation) is covered directly in adsCampaignDrafts tests.
      expect(preview.drafts).toEqual([]);
      expect(preview).toMatchObject({ executionEnabled: false, spendAuthorized: false });
    }
  });
});
