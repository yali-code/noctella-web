import { isObject, paidGetJson, PaidProviderReadError } from "../integrations/ads/paidTransport";
import { requirePaidCredentials, requirePaidEUR } from "../use-cases/ads/paidCampaignCollectorContract";

/**
 * Explicit, manual Meta-only connection verification. This works even when the
 * ad account has no campaigns. It is not an ingestion job, nor proof of spend.
 * Uses only /act_<id> and /act_<id>/insights GET endpoints.
 */
export async function verifyMetaPaidAccountFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  if (env.NOCTELLA_PAID_ADS_PREVIEW_ACK !== "I_AUTHORIZE_PAID_READ_ONLY") {
    throw new Error("Explicit paid API reporting read authorization is required");
  }

  const accountId = env.NOCTELLA_META_AD_ACCOUNT_ID ?? "";
  if (!/^[0-9]{5,25}$/.test(accountId)) {
    throw new Error("Invalid Meta Ads account ID");
  }
  const access = { accessToken: env.NOCTELLA_META_AD_ACCESS_TOKEN ?? "" };
  requirePaidCredentials(access);

  const accountUrl = new URL(`https://graph.facebook.com/v26.0/act_${accountId}`);
  accountUrl.searchParams.set("fields", "account_id,currency");
  const account = await paidGetJson(accountUrl, access, fetchImpl);
  if (!isObject(account) || String(account.account_id) !== accountId) {
    throw new PaidProviderReadError("malformed", "Meta account identity mismatch");
  }
  requirePaidEUR(account.currency);

  // Yesterday is a completed, account-local Meta Insights reporting window.
  // No campaign ID is needed. A successful empty data array is legitimate.
  const insightsUrl = new URL(`https://graph.facebook.com/v26.0/act_${accountId}/insights`);
  insightsUrl.searchParams.set("level", "account");
  insightsUrl.searchParams.set("fields", "impressions,clicks,spend");
  insightsUrl.searchParams.set("date_preset", "yesterday");
  const insights = await paidGetJson(insightsUrl, access, fetchImpl);

  if (!isObject(insights) || !Array.isArray(insights.data) ||
      insights.data.some(row => !isObject(row)) ||
      (isObject(insights.paging) && Boolean(insights.paging.next))) {
    throw new PaidProviderReadError("malformed", "Meta account insights response malformed");
  }

  return {
    mode: "MANUAL_META_READ_ONLY_CHECK" as const,
    provider: "meta" as const,
    accountId,
    currency: "EUR" as const,
    accountAccess: "VERIFIED" as const,
    insightsAccess: "VERIFIED" as const,
    reportRows: insights.data.length,
    spendReconciliation: "NOT_ASSESSED" as const,
    marketplaceAttribution: "NOT_ASSESSED" as const,
    storagePerformed: false as const,
    campaignModified: false as const,
    spendAuthorized: false as const,
  };
}

async function main() {
  try {
    const result = await verifyMetaPaidAccountFromEnv();
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Never print raw Graph API response bodies, headers, exceptions or secrets.
    console.error("Meta paid read-only connection check failed. Verify account, token and ads_read.");
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
