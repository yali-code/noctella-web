import { describe, expect, it } from "vitest";
import { denyAdsConsent, evaluateAdsEventPolicy } from "../lib/adsEventPolicy";

const view = { name: "view_item" as const, productId: "NOC-000007" };
const granted = { decisionRecorded: true, analytics: true, marketing: true };

describe("ADS-002B consent-based event policy", () => {
  it("fails closed when consent is absent or undecided", () => {
    expect(evaluateAdsEventPolicy(null, view).allowedVendors).toEqual([]);
    expect(evaluateAdsEventPolicy({ ...granted, decisionRecorded: false }, view).allowedVendors).toEqual([]);
  });
  it("denied consent dispatches nothing", () => {
    expect(evaluateAdsEventPolicy(denyAdsConsent(), view)).toEqual({ allowedVendors: [], event: null });
  });
  it("analytics-only consent allows only GA4", () => {
    expect(evaluateAdsEventPolicy({ ...granted, marketing: false }, view).allowedVendors).toEqual(["ga4"]);
  });
  it("marketing-only consent allows only Meta and Pinterest", () => {
    expect(evaluateAdsEventPolicy({ ...granted, analytics: false }, view).allowedVendors).toEqual(["meta", "pinterest"]);
  });
  it("complete consent allows all configured vendor categories", () => {
    expect(evaluateAdsEventPolicy(granted, view).allowedVendors).toEqual(["ga4", "meta", "pinterest"]);
  });
  it("does not treat a marketplace exit as a purchase", () => {
    const result = evaluateAdsEventPolicy(granted, { name: "marketplace_outbound_click", productId: "NOC-000007", destination: "ebay" });
    expect(result.event).toEqual({ name: "marketplace_outbound_click", productId: "NOC-000007", destination: "ebay" });
    expect(JSON.stringify(result)).not.toContain("purchase");
  });
  it("rejects malformed incomplete outbound events and extra identity data", () => {
    expect(evaluateAdsEventPolicy(granted, { name: "marketplace_outbound_click", productId: "NOC-000007" }).event).toBeNull();
    expect(evaluateAdsEventPolicy(granted, { name: "view_item", productId: "not valid!" }).event).toBeNull();
    const extra = { ...view, email: "buyer@example.invalid", visitorIp: "127.0.0.1", url: "https://example.invalid/?token=abc" };
    expect(evaluateAdsEventPolicy(granted, extra).event).toEqual(view);
  });
  it("denial after consent revocation blocks later events", () => {
    expect(evaluateAdsEventPolicy(granted, view).event).not.toBeNull();
    expect(evaluateAdsEventPolicy(denyAdsConsent(), view).event).toBeNull();
  });
  it("accepts anonymous page views without product id only after consent", () => {
    expect(evaluateAdsEventPolicy(granted, { name: "page_view" }).event).toEqual({ name: "page_view" });
    expect(evaluateAdsEventPolicy(null, { name: "page_view" }).event).toBeNull();
  });
});
