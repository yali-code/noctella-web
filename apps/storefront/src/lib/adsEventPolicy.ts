/**
 * ADS-002B — Pure privacy-first event policy. No SDK, cookie, localStorage,
 * network, browser global or vendor script is initialized here.
 *
 * Consent MUST be provided by a separately reviewed CMP implementation.
 * A missing or invalid decision is treated as a denial, not implied consent.
 */
export type AdsVendor = "ga4" | "meta" | "pinterest";
export type AdsEventName = "page_view" | "view_item" | "marketplace_outbound_click";

export interface AdsConsentSnapshot {
  readonly analytics: boolean;
  readonly marketing: boolean;
  readonly decisionRecorded: boolean;
}
export interface AdsEventInput {
  readonly name: AdsEventName;
  readonly productId?: string;
  readonly destination?: "ebay" | "etsy";
}
export interface AdsPolicyResult {
  readonly allowedVendors: readonly AdsVendor[];
  readonly event: AdsEventInput | null;
}

const EMPTY: AdsPolicyResult = Object.freeze({ allowedVendors: Object.freeze([]), event: null });
const VALID_EVENTS: ReadonlySet<string> = new Set(["page_view", "view_item", "marketplace_outbound_click"]);

/**
 * Client events only: an outbound click is never equivalent to a marketplace sale.
 * Do not add Purchase to this contract without a separate verified data source.
 */
export function evaluateAdsEventPolicy(
  consent: AdsConsentSnapshot | null | undefined,
  input: AdsEventInput
): AdsPolicyResult {
  if (!consent?.decisionRecorded || !VALID_EVENTS.has(input.name)) return EMPTY;
  if (input.name !== "page_view" && (!input.productId || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.productId))) return EMPTY;
  if (input.name === "marketplace_outbound_click" && input.destination !== "ebay" && input.destination !== "etsy") return EMPTY;

  const vendors: AdsVendor[] = [];
  if (consent.analytics === true) vendors.push("ga4");
  if (consent.marketing === true) vendors.push("meta", "pinterest");
  if (vendors.length === 0) return EMPTY;

  // Whitelist fields. Do not leak email, IP, visitor identity, URL query, or cart data.
  const event: AdsEventInput = input.name === "page_view"
    ? { name: "page_view" }
    : input.name === "view_item"
      ? { name: "view_item", productId: input.productId }
      : { name: "marketplace_outbound_click", productId: input.productId, destination: input.destination };
  return { allowedVendors: vendors, event };
}

/** Explicit withdrawal must prevent every subsequent dispatch attempt. */
export function denyAdsConsent(): AdsConsentSnapshot {
  return { analytics: false, marketing: false, decisionRecorded: true };
}
