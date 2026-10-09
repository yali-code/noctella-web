import { describe, expect, it } from "vitest";
import { inspectPaidAdsProviderReadiness } from "../src/use-cases/ads/paidAdsReadiness";

describe("ADS-005A paid-ad platform separation and readiness", () => {
  it("returns safely disconnected statuses without paid credentials", () => {
    const r = inspectPaidAdsProviderReadiness({});
    expect(r).toHaveLength(3);
    expect(r.every(x => x.status === "NOT_CONFIGURED" && !x.campaignsEnabled && !x.spendAuthorized)).toBe(true);
  });
  it("does not treat existing organic Pinterest or Instagram connections as ads permissions", () => {
    const r = inspectPaidAdsProviderReadiness({
      NOCTELLA_META_AD_ACCOUNT_ID: "123456789",
      NOCTELLA_PINTEREST_AD_ACCOUNT_ID: "123456789",
    });
    expect(r.every(x => !x.configured)).toBe(true);
  });
  it("never exposes paid tokens or enables campaigns even if configuration exists", () => {
    const env = {
      NOCTELLA_META_AD_ACCOUNT_ID: "123456789",
      NOCTELLA_META_AD_ACCESS_TOKEN: "sensitive-meta-token",
      NOCTELLA_GOOGLE_ADS_CUSTOMER_ID: "1234567890",
      NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN: "sensitive-google-developer-token",
      NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "sensitive-google-oauth-token",
      NOCTELLA_PINTEREST_AD_ACCOUNT_ID: "12345678",
      NOCTELLA_PINTEREST_AD_ACCESS_TOKEN: "sensitive-pinterest-token",
    };
    const result = inspectPaidAdsProviderReadiness(env);
    expect(result.map(x => x.status)).toEqual(["CONFIG_REVIEW_REQUIRED", "CONFIG_REVIEW_REQUIRED", "CONFIG_REVIEW_REQUIRED"]);
    expect(result.every(x => x.connectionVerified === false && x.campaignsEnabled === false && x.spendAuthorized === false)).toBe(true);
    for (const token of [env.NOCTELLA_META_AD_ACCESS_TOKEN, env.NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN, env.NOCTELLA_PINTEREST_AD_ACCESS_TOKEN]) {
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });
  it("rejects malformed customer and provider IDs", () => {
    const r = inspectPaidAdsProviderReadiness({ NOCTELLA_META_AD_ACCOUNT_ID:"act_123456789", NOCTELLA_META_AD_ACCESS_TOKEN:"sensitive-token" });
    expect(r[0]?.configured).toBe(false);
  });
});
