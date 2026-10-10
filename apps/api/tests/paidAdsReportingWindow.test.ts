// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPaidObservation, paidReportingWindow, type PaidCampaignQuery, type PaidCampaignObservation } from "../src/use-cases/ads/paidCampaignCollectorContract";

/**
 * Paid analytics periods are provider reporting *calendar* days, not UTC days.
 * These fixtures cross both US daylight-saving transitions and a non-integer UTC offset.
 * No provider credentials, network, real SQLite or advertising actions.
 */
const query: PaidCampaignQuery = {
  provider: "meta", accountId: "3095361257478763", campaignId: "987654321012345",
  startDate: "2026-03-07", endDate: "2026-03-09",
};

describe("ADS-006I provider reporting period UTC provenance", () => {
  it("moves to summer time over the US spring DST transition", () => {
    expect(paidReportingWindow(query, "America/New_York")).toEqual({
      start: "2026-03-07T05:00:00.000Z",
      end: "2026-03-10T04:00:00.000Z",
    });
  });

  it("moves back to winter time and includes the fall DST extra hour", () => {
    expect(paidReportingWindow({
      ...query, startDate: "2025-11-01", endDate: "2025-11-02",
    }, "America/New_York")).toEqual({
      start: "2025-11-01T04:00:00.000Z",
      end: "2025-11-03T05:00:00.000Z",
    });
  });

  it("keeps a non-integer offset and end-date-exclusive boundary", () => {
    expect(paidReportingWindow({
      ...query, startDate: "2026-10-01", endDate: "2026-10-02",
    }, "Asia/Kolkata")).toEqual({
      start: "2026-09-30T18:30:00.000Z",
      end: "2026-10-02T18:30:00.000Z",
    });
  });

  it("refuses unverified zones and a falsified provider window", () => {
    expect(() => paidReportingWindow(query, "Nowhere/Imaginary")).toThrow();
    const observation: PaidCampaignObservation = {
      provider: "meta", accountId: query.accountId, campaignId: query.campaignId,
      sourceReference: "meta.ads.graph_v26_insights", currency: "EUR",
      reportingTimeZone: "America/New_York",
      // These are UTC calendar midnights, *not* account-local reporting midnights.
      window: { start: "2026-03-07T00:00:00.000Z", end: "2026-03-10T00:00:00.000Z" },
      spendEur: 1.25, impressions: 15, clicks: 1, providerReportedConversions: null,
      providerReportedConversionValueEur: null, warnings: [],
    };
    expect(() => assertPaidObservation(observation, query)).toThrow("provenance mismatch");
  });
});
