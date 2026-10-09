import type { AdsEventInput, AdsVendor } from "./adsEventPolicy";
import { dispatchConsentGatedAdsEvent, type AdsAdapters, type AdsDispatchResult } from "./adsConsentDispatcher";
import { CONSENT_STORAGE_KEY } from "./adsConsentStorage";

/**
 * ADS Phase 2: framework-neutral browser adapter binding. Providers remain
 * DISCONNECTED by default, including after a visitor grants consent.
 * This module never imports pixels, inserts scripts or issues network requests.
 */
export interface AdsBrowserRuntime {
  publish(event: AdsEventInput): AdsDispatchResult;
  dispose(): void;
}
export interface AdsBrowserEnvironment {
  readLocalStorage(key: string): string | null;
  addEventListener(type: "storage" | "noctella:ads-consent-changed", listener: () => void): void;
  removeEventListener(type: "storage" | "noctella:ads-consent-changed", listener: () => void): void;
}
/** Inject only vetted, consent-safe adapters after a separate launch review. */
export function createAdsBrowserRuntime(
  environment: AdsBrowserEnvironment,
  configuredAdapters: AdsAdapters = {},
): AdsBrowserRuntime {
  let disposed = false;
  // Consent is checked for every event; never cache a granted decision.
  const adapters: AdsAdapters = { ...configuredAdapters };
  const onChange = () => {
    // Reserved for UI integrations and future cancellation/teardown callbacks.
    // Crucially, consent changes never send an event by themselves.
  };
  environment.addEventListener("storage", onChange);
  environment.addEventListener("noctella:ads-consent-changed", onChange);
  return {
    publish(event) {
      if (disposed) return { deliveredTo: [], skipped: [] };
      return dispatchConsentGatedAdsEvent(event, {
        readStoredConsent: () => environment.readLocalStorage(CONSENT_STORAGE_KEY),
        adapters,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      environment.removeEventListener("storage", onChange);
      environment.removeEventListener("noctella:ads-consent-changed", onChange);
    },
  };
}

export type AdsProviderEvent = {
  readonly name: "page_view" | "view_item" | "marketplace_outbound_click";
  readonly productId?: string;
  readonly destination?: "ebay" | "etsy";
};
/**
 * Provider-agnostic canonical semantics. No Purchase or inferred revenue event.
 * Real Meta/GA4/Pinterest adapters require separate policy/SDK mapping review.
 */
export function mapAllowedProviderEvent(
  vendor: AdsVendor,
  event: Readonly<AdsEventInput>,
): AdsProviderEvent | null {
  if (vendor !== "ga4" && vendor !== "meta" && vendor !== "pinterest") return null;
  if (event.name === "page_view") return { name: "page_view" };
  if (!event.productId || !/^[A-Za-z0-9_-]{1,100}$/.test(event.productId)) return null;
  if (event.name === "view_item") return { name: "view_item", productId: event.productId };
  if (event.name === "marketplace_outbound_click" && (event.destination === "ebay" || event.destination === "etsy")) {
    return { name: "marketplace_outbound_click", productId: event.productId, destination: event.destination };
  }
  return null;
}
