import type { AdsConsentSnapshot } from "./adsEventPolicy";

export const CONSENT_STORAGE_KEY = "noctella.ads-consent.v1";
export const CONSENT_POLICY_VERSION = 1;
export interface StoredConsent {
  readonly version: number;
  readonly analytics: boolean;
  readonly marketing: boolean;
  readonly savedAt: string;
}
export function readConsent(raw: string | null): AdsConsentSnapshot | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const value = data as Partial<StoredConsent>;
    if (value.version !== CONSENT_POLICY_VERSION || typeof value.analytics !== "boolean" || typeof value.marketing !== "boolean" || typeof value.savedAt !== "string") return null;
    if (Number.isNaN(Date.parse(value.savedAt))) return null;
    return { decisionRecorded: true, analytics: value.analytics, marketing: value.marketing };
  } catch { return null; }
}
export function serializeConsent(value: AdsConsentSnapshot, now: string): string {
  if (!value.decisionRecorded || Number.isNaN(Date.parse(now))) throw new Error("Only a valid explicit consent decision can be stored");
  return JSON.stringify({ version: CONSENT_POLICY_VERSION, analytics: value.analytics === true, marketing: value.marketing === true, savedAt: now });
}
