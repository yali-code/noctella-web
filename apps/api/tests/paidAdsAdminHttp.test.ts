// @vitest-environment node
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
// Synthetic, non-functional values: proves readiness reports presence only, never the value.
process.env.NOCTELLA_META_AD_ACCOUNT_ID = "3095361257478763";
process.env.NOCTELLA_META_AD_ACCESS_TOKEN = "fixture-meta-token-must-never-be-echoed";

import { sql } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminRole } from "@noctella/shared";
import { storeVerifiedPaidCampaignEvidence } from "../src/services/paidAdsCollection";
import type { PaidCampaignObservation, PaidCampaignQuery } from "../src/use-cases/ads/paidCampaignCollectorContract";

/**
 * Phase 6 acceptance: the authenticated analytics.view Admin read path over the real Express app
 * and real (in-memory) SQLite. No provider call, no credential value, no mutation route.
 */
const query: PaidCampaignQuery = { provider: "meta", accountId: "3095361257478763", campaignId: "120210000000000001", startDate: "2026-10-01", endDate: "2026-10-02" };
const observation: PaidCampaignObservation = {
  provider: "meta", accountId: query.accountId, campaignId: query.campaignId, sourceReference: "meta.ads.graph_v26_insights", currency: "EUR",
  reportingTimeZone: "Europe/Sofia", window: { start: "2026-09-30T21:00:00.000Z", end: "2026-10-02T21:00:00.000Z" },
  spendEur: 12.34, impressions: 900, clicks: 21, providerReportedConversions: null, providerReportedConversionValueEur: null, warnings: [],
};
const performancePath = `/api/analytics/ads/performance/meta/${query.campaignId}`;
const readinessPath = "/api/analytics/ads/providers/readiness";

describe("Phase 6 paid reporting - authenticated read-only Admin HTTP contract", () => {
  let app: import("express").Express;
  let db: any;
  let ownerCookie = "";
  let editorCookie = "";

  async function login(role: AdminRole) {
    const { createAdminUser } = await import("../src/services/adminAuth");
    await createAdminUser(db, { email: `${role}@example.com`, password: "Correct-Horse-9!", role });
    const res = await request(app).post("/api/auth/login").send({ email: `${role}@example.com`, password: "Correct-Horse-9!" });
    const cookie = res.headers["set-cookie"];
    return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0]!;
  }
  const analyticsCounts = () => db.all(sql`SELECT (SELECT count(*) FROM analytics_runs) AS runs, (SELECT count(*) FROM analytics_metric_snapshots) AS snapshots`);

  beforeAll(async () => {
    app = (await import("../src/app")).default as any;
    db = (await import("../src/db/client")).db;
    ownerCookie = await login(AdminRole.Owner);
    editorCookie = await login(AdminRole.ProductEditor);
  }, 60_000);

  it("requires a session (401) and analytics.view (403) for paid report and readiness", async () => {
    for (const path of [performancePath, readinessPath]) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set("Cookie", editorCookie)).status).toBe(403);
    }
  });

  it("reports NOT_COLLECTED before any verified collection, without writing", async () => {
    const before = analyticsCounts();
    const res = await request(app).get(performancePath).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ status: "NOT_COLLECTED", evidence: null, marketplaceAttributionVerified: false, spendAuthorized: false });
    expect(analyticsCounts()).toEqual(before);
  });

  it("serves stored provider evidence read-only with account-local window, no ROAS or marketplace attribution", async () => {
    storeVerifiedPaidCampaignEvidence(db, query, observation, new Date("2026-10-09T12:00:00.000Z"));
    const before = analyticsCounts();
    const res = await request(app).get(performancePath).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "REPORT_AVAILABLE", provider: "meta", campaignId: query.campaignId, period: observation.window,
      marketplaceAttributionVerified: false, spendAuthorized: false,
      evidence: { spendEur: 12.34, impressions: 900, clicks: 21, providerReportedConversions: null, marketplaceConfirmedOrders: null, reportedRoas: null, attributedMarketplaceRevenueEur: null },
      advice: { eligibleForAutomaticAction: false, campaignPauseExecuted: false, budgetChangeEur: null },
    });
    expect(analyticsCounts()).toEqual(before);
  });

  it("readiness reports configuration presence only - never connection verification, spend permission or secret values", async () => {
    const res = await request(app).get(readinessPath).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ campaignsEnabled: false, spendAuthorized: false });
    expect(res.body.providers.find((p: any) => p.platform === "meta")).toMatchObject({ configured: true, status: "CONFIG_REVIEW_REQUIRED", connectionVerified: false, campaignsEnabled: false, spendAuthorized: false });
    expect(res.body.providers.find((p: any) => p.platform === "google_ads")).toMatchObject({ configured: false, status: "NOT_CONFIGURED" });
    expect(JSON.stringify(res.body)).not.toContain("fixture-meta-token");
  });

  it("validates identifiers and exposes no mutation route for paid reporting or readiness", async () => {
    expect((await request(app).get("/api/analytics/ads/performance/meta/not-a-campaign").set("Cookie", ownerCookie)).status).toBe(400);
    expect((await request(app).get(`/api/analytics/ads/performance/tiktok/${query.campaignId}`).set("Cookie", ownerCookie)).status).toBe(400);
    for (const path of [performancePath, readinessPath]) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        expect((await request(app)[method](path).set("Cookie", ownerCookie).send({ spendAuthorized: true })).status).toBe(404);
      }
    }
  });
});
