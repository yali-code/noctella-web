import { describe, expect, it, vi } from "vitest";
import { dispatchConsentGatedAdsEvent } from "../lib/adsConsentDispatcher";
import { serializeConsent } from "../lib/adsConsentStorage";

const event = { name: "view_item" as const, productId: "NOC-000007" };
const full = serializeConsent({ analytics: true, marketing: true, decisionRecorded: true }, "2026-10-09T10:00:00.000Z");
const analytics = serializeConsent({ analytics: true, marketing: false, decisionRecorded: true }, "2026-10-09T10:00:00.000Z");
const denied = serializeConsent({ analytics: false, marketing: false, decisionRecorded: true }, "2026-10-09T10:00:00.000Z");

describe("ADS-002B.3 consent-gated adapter dispatch", () => {
  it("does not call any adapter on missing consent", () => {
    const ga4 = vi.fn(); const meta = vi.fn();
    expect(dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => null, adapters: { ga4, meta } }).deliveredTo).toEqual([]);
    expect(ga4).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
  });
  it("never sends on invalid consent JSON or throwing consent store", () => {
    const ga4 = vi.fn();
    dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => "not-json", adapters: { ga4 } });
    dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => { throw new Error("blocked"); }, adapters: { ga4 } });
    expect(ga4).not.toHaveBeenCalled();
  });
  it("sends analytics only when only analytics consent is granted", () => {
    const ga4 = vi.fn(); const meta = vi.fn(); const pinterest = vi.fn();
    const result = dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => analytics, adapters: { ga4, meta, pinterest } });
    expect(result.deliveredTo).toEqual(["ga4"]);
    expect(ga4).toHaveBeenCalledWith(event);
    expect(meta).not.toHaveBeenCalled();
    expect(pinterest).not.toHaveBeenCalled();
  });
  it("checks permission anew after consent withdrawal", () => {
    const ga4 = vi.fn(); const meta = vi.fn();
    let saved = full;
    const deps = { readStoredConsent: () => saved, adapters: { ga4, meta } };
    expect(dispatchConsentGatedAdsEvent(event, deps).deliveredTo).toEqual(["ga4", "meta"]);
    saved = denied;
    expect(dispatchConsentGatedAdsEvent(event, deps).deliveredTo).toEqual([]);
    expect(ga4).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledTimes(1);
  });
  it("does not fabricate sales from outbound clicks", () => {
    const ga4 = vi.fn();
    dispatchConsentGatedAdsEvent({ name: "marketplace_outbound_click", productId: "NOC-000007", destination: "etsy" }, { readStoredConsent: () => full, adapters: { ga4 } });
    expect(ga4).toHaveBeenCalledWith({ name: "marketplace_outbound_click", productId: "NOC-000007", destination: "etsy" });
  });
  it("rejects improperly structured events", () => {
    const meta = vi.fn();
    dispatchConsentGatedAdsEvent({ name: "marketplace_outbound_click", productId: "NOC-000007" }, { readStoredConsent: () => full, adapters: { meta } });
    expect(meta).not.toHaveBeenCalled();
  });
  it("does not forward PII and extra caller fields", () => {
    const meta = vi.fn();
    const eventWithExtraData = { ...event, email: "not@for.advertisers" };
    dispatchConsentGatedAdsEvent(eventWithExtraData, { readStoredConsent: () => full, adapters: { meta } });
    expect(meta).toHaveBeenCalledWith(event);
  });
  it("isolates provider failures", () => {
    const ga4 = vi.fn(() => { throw new Error("provider unavailable"); }); const meta = vi.fn();
    const result = dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => full, adapters: { ga4, meta } });
    expect(result.skipped).toContain("ga4");
    expect(result.deliveredTo).toContain("meta");
  });
  it("skips adapters not explicitly provided", () => {
    const result = dispatchConsentGatedAdsEvent(event, { readStoredConsent: () => full, adapters: {} });
    expect(result.deliveredTo).toEqual([]);
    expect(result.skipped).toEqual(["ga4", "meta", "pinterest"]);
  });
});
