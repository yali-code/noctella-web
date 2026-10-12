import { MetaPaidCampaignClient } from "../integrations/ads/metaPaidCampaignClient";
import {
  assertPaidCampaignQuery, assertPaidObservation, requirePaidCredentials,
  type PaidAdsReadOnlyClient, type PaidCampaignObservation, type PaidCampaignQuery,
} from "../use-cases/ads/paidCampaignCollectorContract";
import { verifyMetaE07BackupPreflight, type E07PreflightEnv } from "./verifyMetaE07BackupPreflight";

/**
 * ADS-009M — manual Meta-only staging E07 operator command.
 *
 * No scheduler, API route, Admin button, ad creation or budget mutation.
 * The default operation is preflight, which does not touch the ERP database or Meta.
 * In particular, do not statically import db/client: it initializes and may migrate
 * the live SQLite database on import. Load it ONLY after all write gates pass.
 */
export type E07Operation = "preflight" | "preview" | "write";
type E07Stored = {
  readonly run: { readonly id: string; readonly status: string };
  readonly replayed: boolean;
  readonly spendAuthorized: false;
};
type E07Dependencies = {
  readonly verifyBackup?: (env: E07PreflightEnv, now: Date) => Promise<Awaited<ReturnType<typeof verifyMetaE07BackupPreflight>>>;
  readonly client?: PaidAdsReadOnlyClient;
  readonly persist?: (query: PaidCampaignQuery, observation: PaidCampaignObservation, now: Date) => Promise<E07Stored>;
};

function selectedOperation(value: string | undefined): E07Operation {
  if (value === undefined || value === "preflight") return "preflight";
  if (value === "preview" || value === "write") return value;
  throw new Error("E07 operation not supported");
}

function scopedQuery(env: E07PreflightEnv): PaidCampaignQuery {
  const query: PaidCampaignQuery = {
    provider: "meta",
    accountId: env.NOCTELLA_META_AD_ACCOUNT_ID ?? "",
    campaignId: env.NOCTELLA_PAID_ADS_CAMPAIGN_ID ?? "",
    startDate: env.NOCTELLA_PAID_ADS_START_DATE ?? "",
    endDate: env.NOCTELLA_PAID_ADS_END_DATE ?? "",
  };
  assertPaidCampaignQuery(query);
  return query;
}

export async function runMetaE07Staging(
  env: E07PreflightEnv = process.env,
  dependencies: E07Dependencies = {},
  now = new Date(),
) {
  const operation = selectedOperation(env.NOCTELLA_E07_OPERATION);

  // A per-invocation write acknowledgement is REQUIRED in addition to the
  // separate staged read/write scope acknowledgements validated by preflight.
  // Never make this a permanent service environment variable.
  if (operation === "write" &&
      env.NOCTELLA_E07_ONE_TIME_WRITE_ACK !== "I_AUTHORIZE_ONE_TIME_STAGING_SNAPSHOT_WRITE") {
    throw new Error("E07 staging snapshot write not authorized");
  }

  // Validate local scope/token *before* R2 network access; token is never output.
  const query = scopedQuery(env);
  const access = { accessToken: env.NOCTELLA_META_AD_ACCESS_TOKEN ?? "" };
  if (operation !== "preflight") requirePaidCredentials(access);

  const backup = await (dependencies.verifyBackup ??
    ((e, t) => verifyMetaE07BackupPreflight(e, undefined, t)))(env, now);
  if (operation === "preflight") {
    return { ...backup, operation, providerCalled: false as const,
      databaseWritePerformed: false as const, spendAuthorized: false as const };
  }

  const client = dependencies.client ?? new MetaPaidCampaignClient();
  if (client.provider !== "meta") throw new Error("E07 provider mismatch");
  const observation = await client.fetchCampaign(query, access);
  assertPaidObservation(observation, query);
  if (Date.parse(observation.window.end) > now.getTime()) {
    throw new Error("E07 reporting day not completed in Meta account timezone");
  }

  // A successful empty Insights response is NOT proof of zero spend and must
  // never open/migrate the staging ERP SQLite or create synthetic snapshots.
  const hasEvidence = [
    observation.spendEur, observation.impressions, observation.clicks,
    observation.providerReportedConversions, observation.providerReportedConversionValueEur,
  ].some(v => v !== null);
  if (!hasEvidence) {
    return { operation, status: "NO_CAMPAIGN_REPORT" as const, provider: "meta" as const,
      databaseWritePerformed: false as const, campaignModified: false as const,
      spendAuthorized: false as const };
  }

  if (operation === "preview") {
    return { operation, status: "PREVIEW_ONLY" as const, provider: "meta" as const,
      window: observation.window, reportingTimeZone: observation.reportingTimeZone,
      spendEur: observation.spendEur, impressions: observation.impressions,
      clicks: observation.clicks, databaseWritePerformed: false as const,
      campaignModified: false as const, spendAuthorized: false as const };
  }

  const persist = dependencies.persist ?? (async (q: PaidCampaignQuery, o: PaidCampaignObservation, t: Date) => {
    // Must be dynamic: db/client opens SQLite and can ensure schema during import.
    const [{ db }, { storeVerifiedPaidCampaignEvidence }] = await Promise.all([
      import("../db/client"), import("../services/paidAdsCollection"),
    ]);
    return storeVerifiedPaidCampaignEvidence(db, q, o, t);
  });
  const result = await persist(query, observation, now);
  return { operation, status: "STORED" as const, provider: "meta" as const,
    runId: result.run.id, runStatus: result.run.status,
    replayed: result.replayed, databaseWritePerformed: !result.replayed,
    campaignModified: false as const, spendAuthorized: false as const };
}

async function main() {
  try { console.log(JSON.stringify(await runMetaE07Staging(), null, 2)); }
  catch {
    // Vendor errors, tokens, raw response bodies and DB paths must not be logged.
    console.error("E07 manual staging operation denied or failed. No campaign or spend action was attempted.");
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
