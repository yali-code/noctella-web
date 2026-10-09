import { describe, expect, it, vi } from "vitest";
import { createAdsBrowserRuntime, mapAllowedProviderEvent, type AdsBrowserEnvironment } from "../lib/adsBrowserRuntime";
import { serializeConsent } from "../lib/adsConsentStorage";

const full = serializeConsent({ decisionRecorded: true, analytics: true, marketing: true }, "2026-10-09T00:00:00.000Z");
const denied = serializeConsent({ decisionRecorded: true, analytics: false, marketing: false }, "2026-10-09T00:00:00.000Z");
function browser(initial: string | null) {
  let current = initial;
  const listeners = new Map<string, Set<() => void>>();
  const env: AdsBrowserEnvironment = {
    readLocalStorage: () => current,
    addEventListener: (type, cb) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(cb); },
    removeEventListener: (type, cb) => { listeners.get(type)?.delete(cb); },
  };
  return { env, set: (x: string | null) => { current = x; }, listeners };
}
describe("ADS Phase 2 no-provider-by-default browser boundary", () => {
  it("does not send to vendors even when consent is accepted until a vetted adapter is injected", () => {
    const b = browser(full);
    const rt = createAdsBrowserRuntime(b.env);
    expect(rt.publish({ name: "page_view" }).deliveredTo).toEqual([]);
    rt.dispose();
    expect(b.listeners.get("storage")?.size).toBe(0);
  });
  it("cannot transmit without explicit stored consent", () => {
    const b = browser(null);
    const ga4 = vi.fn();
    const rt = createAdsBrowserRuntime(b.env, { ga4 });
    rt.publish({ name: "page_view" });
    b.set("not-json");
    rt.publish({ name: "page_view" });
    b.set(denied);
    rt.publish({ name: "page_view" });
    expect(ga4).not.toHaveBeenCalled();
    rt.dispose();
  });
  it("enforces withdrawal and selective permission on every event", () => {
    const b = browser(full), ga4 = vi.fn(), meta = vi.fn();
    const rt = createAdsBrowserRuntime(b.env, { ga4, meta });
    rt.publish({ name: "page_view" });
    expect(ga4).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledTimes(1);
    b.set(denied);
    rt.publish({ name: "page_view" });
    expect(ga4).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledTimes(1);
    rt.dispose();
    rt.publish({ name: "page_view" });
    expect(ga4).toHaveBeenCalledTimes(1);
  });
  it("never maps click to Purchase and drops user fields", () => {
    const event = { name: "marketplace_outbound_click" as const, productId: "NOC-000007", destination: "ebay" as const, email: "do-not-send@example.com" };
    expect(mapAllowedProviderEvent("meta", event)).toEqual({ name: "marketplace_outbound_click", productId: "NOC-000007", destination: "ebay" });
    expect(JSON.stringify(mapAllowedProviderEvent("meta", event))).not.toContain("email");
    expect(JSON.stringify(mapAllowedProviderEvent("meta", event))).not.toContain("purchase");
  });
});
