/**
 * ADS-005A: paid advertising connections are separate from organic Instagram,
 * Pinterest social analytics, eBay marketplace and GA4 browser measurement.
 *
 * Server-side configuration is deliberately DORMANT: no token use, OAuth
 * requests, network calls, cookie handling or campaign mutation here.
 */
export type PaidAdsPlatform = "meta" | "google_ads" | "pinterest_ads";
export type PaidAdsReadinessStatus = "NOT_CONFIGURED" | "CONFIG_REVIEW_REQUIRED";
export interface PaidAdsProviderReadiness {
  readonly platform: PaidAdsPlatform;
  readonly status: PaidAdsReadinessStatus;
  readonly configured: boolean;
  readonly requiredChecks: readonly string[];
  readonly connectionVerified: false;
  readonly campaignsEnabled: false;
  readonly spendAuthorized: false;
}
export interface PaidAdsProviderEnvironment {
  readonly NOCTELLA_META_AD_ACCOUNT_ID?: string;
  readonly NOCTELLA_META_AD_ACCESS_TOKEN?: string;
  readonly NOCTELLA_GOOGLE_ADS_CUSTOMER_ID?: string;
  readonly NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  readonly NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN?: string;
  readonly NOCTELLA_PINTEREST_AD_ACCOUNT_ID?: string;
  readonly NOCTELLA_PINTEREST_AD_ACCESS_TOKEN?: string;
}
const digits = (s?: string) => typeof s === "string" && /^[0-9]{5,25}$/.test(s);
const secret = (s?: string) => typeof s === "string" && s.trim().length >= 8;
const META_CHECKS = ["Verify Meta Business ad account ownership and Ads Management permissions", "Verify marketing legal basis and target regions", "Verify billing, account restrictions and app review"] as const;
const GOOGLE_CHECKS = ["Verify Google Ads customer, developer-token access level and OAuth scopes", "Verify billing and policies", "Verify account authorization independently of GA4"] as const;
const PINTEREST_CHECKS = ["Verify Pinterest Ads account access and advertising scopes separately from social analytics OAuth", "Verify billing and policy permissions", "Confirm advertising API eligibility"] as const;

export function inspectPaidAdsProviderReadiness(
  env: PaidAdsProviderEnvironment = process.env,
): readonly PaidAdsProviderReadiness[] {
  const configurations: readonly [PaidAdsPlatform, boolean, readonly string[]][] = [
    ["meta", digits(env.NOCTELLA_META_AD_ACCOUNT_ID) && secret(env.NOCTELLA_META_AD_ACCESS_TOKEN), META_CHECKS],
    ["google_ads", digits(env.NOCTELLA_GOOGLE_ADS_CUSTOMER_ID) && secret(env.NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN) && secret(env.NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN), GOOGLE_CHECKS],
    ["pinterest_ads", digits(env.NOCTELLA_PINTEREST_AD_ACCOUNT_ID) && secret(env.NOCTELLA_PINTEREST_AD_ACCESS_TOKEN), PINTEREST_CHECKS],
  ];
  return configurations.map(([platform, configured, requiredChecks]) => ({
    platform, status: configured ? "CONFIG_REVIEW_REQUIRED" : "NOT_CONFIGURED",
    configured, requiredChecks, connectionVerified: false, campaignsEnabled: false,
    spendAuthorized: false,
  }));
}
