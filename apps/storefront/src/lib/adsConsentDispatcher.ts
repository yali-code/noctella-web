import { evaluateAdsEventPolicy, type AdsEventInput, type AdsVendor } from "./adsEventPolicy";
import { readConsent } from "./adsConsentStorage";

/**
 * ADS-002B.3: fail-closed dispatcher with injected provider adapters.
 * No Pixel, GA4, Pinterest SDK, network request, cookies or script injection.
 * Every event re-reads consent; adapters are never called on denial or storage error.
 */
export type AdsVendorAdapter = (event: Readonly<AdsEventInput>) => void;
export type AdsAdapters = Readonly<Partial<Record<AdsVendor, AdsVendorAdapter>>>;

export interface AdsDispatchDependencies {
  /** Caller supplies a CMP-approved decision source. A missing/blocked source is denied. */
  readStoredConsent(): string | null;
  readonly adapters: AdsAdapters;
}

export interface AdsDispatchResult {
  readonly deliveredTo: readonly AdsVendor[];
  readonly skipped: readonly AdsVendor[];
}

export function dispatchConsentGatedAdsEvent(
  event: AdsEventInput,
  dependencies: AdsDispatchDependencies
): AdsDispatchResult {
  let consent = null;
  try {
    consent = readConsent(dependencies.readStoredConsent());
  } catch {
    // Blocked storage or unexpected CMP failure must never imply permission.
  }
  const decision = evaluateAdsEventPolicy(consent, event);
  const deliveredTo: AdsVendor[] = [];
  const skipped: AdsVendor[] = [];

  if (!decision.event) return { deliveredTo, skipped };
  for (const vendor of decision.allowedVendors) {
    const adapter = dependencies.adapters[vendor];
    if (!adapter) {
      skipped.push(vendor);
      continue;
    }
    try {
      adapter(decision.event);
      deliveredTo.push(vendor);
    } catch {
      // Adapter failures must not block another permitted provider or checkout navigation.
      skipped.push(vendor);
    }
  }
  return { deliveredTo, skipped };
}
