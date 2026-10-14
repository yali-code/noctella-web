import { MetaAdAbReadOnlyClient, type MetaAdPairQuery } from "../integrations/ads/metaAdAbReadOnlyClient";
import { compareMetaAdTraffic } from "../use-cases/ads/metaAdAbComparison";

/**
 * ADS-AB1: MANUAL, staging-only Meta ad-level comparison preview.
 * No HTTP route, scheduler, provider mutation, ERP DB import, R2 or persistence.
 * NOT approved for live Meta API calls merely because this command exists.
 * Any live execution needs independently scoped, explicit owner authorization.
 */
export async function previewMetaAdAbFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
) {
  if (env.RENDER_SERVICE_NAME !== "noctella-staging-api"
    || env.DATABASE_DRIVER !== "sqlite"
    || env.DATABASE_URL !== "/var/data/noctella.sqlite") {
    throw new Error("ADS-AB1 staging environment guard denied");
  }
  if (env.NOCTELLA_PAID_ADS_PREVIEW_ACK !== "I_AUTHORIZE_PAID_READ_ONLY"
    || env.NOCTELLA_AB_PREVIEW_ACK !== "I_AUTHORIZE_META_AD_AB_READ_ONLY") {
    throw new Error("ADS-AB1 exact-scope provider read authorizations required");
  }
  const query: MetaAdPairQuery = {
    provider: "meta",
    accountId: env.NOCTELLA_META_AD_ACCOUNT_ID ?? "",
    campaignId: env.NOCTELLA_AB_CAMPAIGN_ID ?? "",
    adAId: env.NOCTELLA_AB_AD_A_ID ?? "",
    adBId: env.NOCTELLA_AB_AD_B_ID ?? "",
    startDate: env.NOCTELLA_AB_START_DATE ?? "",
    endDate: env.NOCTELLA_AB_END_DATE ?? "",
  };
  const [a, b] = await new MetaAdAbReadOnlyClient(fetchImpl, () => now)
    .fetchAdPair(query, { accessToken: env.NOCTELLA_META_AD_ACCESS_TOKEN ?? "" });
  return {
    ...compareMetaAdTraffic(a, b),
    operation: "PREVIEW_ONLY" as const,
    providerCalled: true as const,
    databaseWritePerformed: false as const,
    campaignModified: false as const,
    spendAuthorized: false as const,
  };
}

async function main() {
  try {
    console.log(JSON.stringify(await previewMetaAdAbFromEnv(), null, 2));
  } catch {
    // Do not print provider exception bodies, account tokens, env values or raw payloads.
    console.error("ADS-AB1 staging ad comparison preview denied or failed; no ad or spend action attempted.");
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
