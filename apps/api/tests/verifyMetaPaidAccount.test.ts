// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { verifyMetaPaidAccountFromEnv } from "../src/scripts/verifyMetaPaidAccount";

const token = "fake-meta-paid-token-for-tests";
const accountId = "3095361257478763";
const validEnv = {
  NOCTELLA_PAID_ADS_PREVIEW_ACK: "I_AUTHORIZE_PAID_READ_ONLY",
  NOCTELLA_META_AD_ACCOUNT_ID: accountId,
  NOCTELLA_META_AD_ACCESS_TOKEN: token,
};

function mockFetch(
  insightsData: unknown = [],
  currency = "EUR",
  reportedAccountId = accountId,
) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    const payload = url.pathname.endsWith("/insights")
      ? { data: insightsData }
      : { account_id: reportedAccountId, currency };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, requests };
}

describe("manual Meta paid account-only readiness verification", () => {
  it("denies any provider access without explicit owner read approval", async () => {
    const f = mockFetch();
    await expect(verifyMetaPaidAccountFromEnv({
      ...validEnv, NOCTELLA_PAID_ADS_PREVIEW_ACK: "",
    }, f.fn)).rejects.toThrow("authorization");
    expect(f.requests).toHaveLength(0);
  });

  it("validates an empty EUR ad account without inventing zero spend or sales", async () => {
    const f = mockFetch();
    const result = await verifyMetaPaidAccountFromEnv(validEnv, f.fn);
    expect(result).toMatchObject({
      mode: "MANUAL_META_READ_ONLY_CHECK",
      accountId, currency: "EUR", accountAccess: "VERIFIED",
      insightsAccess: "VERIFIED", reportRows: 0,
      spendReconciliation: "NOT_ASSESSED",
      marketplaceAttribution: "NOT_ASSESSED",
      storagePerformed: false, campaignModified: false, spendAuthorized: false,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.requests).toHaveLength(2);
    for (const { url, init } of f.requests) {
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("graph.facebook.com");
      expect(url.href).not.toContain(token);
      expect(url.searchParams.has("access_token")).toBe(false);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    }
    const insights = f.requests[1]!.url;
    expect(insights.pathname).toBe(`/v26.0/act_${accountId}/insights`);
    expect(insights.searchParams.get("level")).toBe("account");
    expect(insights.searchParams.get("date_preset")).toBe("yesterday");
    expect(insights.searchParams.has("filtering")).toBe(false);
  });

  it("does not treat reported rows as verified spend or conversions", async () => {
    const f = mockFetch([{ spend: "0.00", impressions: "25", clicks: "2" }]);
    const result = await verifyMetaPaidAccountFromEnv(validEnv, f.fn);
    expect(result.reportRows).toBe(1);
    expect(result.spendReconciliation).toBe("NOT_ASSESSED");
    expect(result.marketplaceAttribution).toBe("NOT_ASSESSED");
    expect(JSON.stringify(result)).not.toContain("0.00");
  });

  it("rejects account mismatch and wrong currency before querying insights", async () => {
    const wrongId = mockFetch([], "EUR", "987654321");
    await expect(verifyMetaPaidAccountFromEnv(validEnv, wrongId.fn))
      .rejects.toThrow("identity mismatch");
    expect(wrongId.requests).toHaveLength(1);

    const wrongCurrency = mockFetch([], "USD");
    await expect(verifyMetaPaidAccountFromEnv(validEnv, wrongCurrency.fn))
      .rejects.toThrow("EUR");
    expect(wrongCurrency.requests).toHaveLength(1);
  });

  it("rejects missing credentials or malformed IDs without network calls", async () => {
    const f = mockFetch();
    await expect(verifyMetaPaidAccountFromEnv({
      ...validEnv, NOCTELLA_META_AD_ACCOUNT_ID: "act_123",
    }, f.fn)).rejects.toThrow("Invalid Meta Ads account ID");
    await expect(verifyMetaPaidAccountFromEnv({
      ...validEnv, NOCTELLA_META_AD_ACCESS_TOKEN: "",
    }, f.fn)).rejects.toThrow("access not configured");
    expect(f.requests).toHaveLength(0);
  });

  it("rejects malformed Insights response instead of claiming successful access", async () => {
    const f = mockFetch("not-an-array");
    await expect(verifyMetaPaidAccountFromEnv(validEnv, f.fn))
      .rejects.toThrow("malformed");
    expect(f.requests).toHaveLength(2);
  });
});
