// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import { MetaPaidCampaignClient } from "../src/integrations/ads/metaPaidCampaignClient";
import { collectPaidCampaignEvidence } from "../src/services/paidAdsCollection";
import { assertPaidCampaignQuery, type PaidCampaignQuery } from "../src/use-cases/ads/paidCampaignCollectorContract";

/**
 * Audit finding D: completeness was checked partly against an injected `now` and partly against the
 * wall clock (Date.now()), so the same inputs passed or failed depending on when they ran.
 * The window here is TOMORROW in wall-clock time, so only the injected clock can make it complete.
 */
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const after = (d: string, ms: number) => new Date(Date.parse(`${d}T00:00:00.000Z`) + 86_400_000 + ms);
const query: PaidCampaignQuery = { provider: "meta", accountId: "123456789", campaignId: "12345678901", startDate: day, endDate: day };
function meta() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("/insights")
      ? { data: [{ campaign_id: query.campaignId, date_start: day, date_stop: day, spend: "3.00", impressions: "100", clicks: "4" }] }
      : { account_id: query.accountId, currency: "EUR", timezone_name: "UTC" };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}
const run = (now: Date) => collectPaidCampaignEvidence(createTestDb(), new MetaPaidCampaignClient(meta()), query, { accessToken: "clock-test-token-1234" },
  { explicitReadApproval: true, explicitSnapshotWriteApproval: true, now });

describe("paid collection uses one clock for every completeness check", () => {
  it("accepts a window that is complete at the injected time, even though the wall clock is earlier", async () => {
    await expect(run(after(day, 0))).resolves.toMatchObject({ status: "STORED", replayed: false });
  });

  it("rejects the same window one millisecond before its end at the injected time", async () => {
    await expect(run(after(day, -1))).rejects.toThrow(/complete|not ended/);
  });

  it("query validation honours the injected clock and still defaults to the wall clock", () => {
    expect(() => assertPaidCampaignQuery(query, after(day, 0))).not.toThrow();
    expect(() => assertPaidCampaignQuery(query)).toThrow(/complete/);
  });
});

describe("account-local completeness with a consistent injected clock (west of UTC)", () => {
  // America/Los_Angeles is UTC-7 on 2026-03-10: the local day ends at 2026-03-11T07:00Z,
  // seven hours after the UTC day - only the account-local check can reject in between.
  const la: PaidCampaignQuery = { ...query, startDate: "2026-03-10", endDate: "2026-03-10" };
  const laFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("/insights")
      ? { data: [{ campaign_id: la.campaignId, date_start: la.startDate, date_stop: la.endDate, spend: "3.00", impressions: "100", clicks: "4" }] }
      : { account_id: la.accountId, currency: "EUR", timezone_name: "America/Los_Angeles" };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const collect = (now: string) => collectPaidCampaignEvidence(createTestDb(), new MetaPaidCampaignClient(laFetch), la, { accessToken: "clock-test-token-1234" },
    { explicitReadApproval: true, explicitSnapshotWriteApproval: true, now: new Date(now) });

  it("rejects after the UTC day but before the local day ends, and stores exactly at the local end", async () => {
    await expect(collect("2026-03-11T06:59:59.999Z")).rejects.toThrow(/not ended in the provider account time zone/);
    await expect(collect("2026-03-11T07:00:00.000Z")).resolves.toMatchObject({ status: "STORED" });
  });
});
