import { PublishChannel } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { EbayAnalyticsCollector } from "../integrations/ebay/ebayAnalyticsCollector";
import { EBAY_ANALYTICS_SCOPE, resolveEbayOAuthConfig } from "../integrations/ebay/ebayOAuth";
import { createSqliteAnalyticsSnapshotRepository } from "../repositories/analytics/analyticsSnapshotsSqlite";
import { ExternalCollectorError } from "../use-cases/analytics/externalMetrics";
import { runExternalAnalyticsCollection } from "./externalAnalytics";
import { EbayAdapter } from "./marketplaceAdapters";
import { refreshConnection } from "./marketplacePublishing";

/**
 * Stage 3B: eBay Sell Analytics readiness + collection. Readiness is derived (no schema change)
 * and sanitized - booleans and non-secret metadata only. Collection never calls eBay with an
 * under-scoped connection (consent given before sell.analytics.readonly was requested): that is
 * ANALYTICS_RECONSENT_REQUIRED and must be fixed by the owner reconnecting.
 */
const REFRESH_SKEW_MS = 60_000;

export function getEbayAnalyticsReadiness(db: DbClient, env: Record<string, string | undefined> = process.env, now: Date = new Date()) {
  const connection = createSqliteAnalyticsSnapshotRepository(db).findConnectionSummary(PublishChannel.Ebay);
  const marketplaceId = env.EBAY_ANALYTICS_MARKETPLACE_ID?.trim() || null;
  const clientCredentialsConfigured = resolveEbayOAuthConfig(env) !== null;
  const connected = connection?.status === "connected";
  const accessTokenExpired = connection?.tokenExpiresAt ? Date.parse(connection.tokenExpiresAt) <= now.getTime() + REFRESH_SKEW_MS : null;
  const analyticsScopePresent = Boolean(connection?.scopes.includes(EBAY_ANALYTICS_SCOPE));
  const reconsentRequired = Boolean(connection) && (!analyticsScopePresent || connection!.status === "revoked");
  const blockers = [
    ...(clientCredentialsConfigured ? [] : ["EBAY_CLIENT_CREDENTIALS_MISSING"]),
    ...(marketplaceId ? [] : ["EBAY_ANALYTICS_MARKETPLACE_ID_MISSING"]),
    ...(connection ? [] : ["EBAY_CONNECTION_MISSING"]),
    ...(connection && !connected ? [`EBAY_CONNECTION_${connection.status.toUpperCase()}`] : []),
    ...(reconsentRequired ? ["ANALYTICS_RECONSENT_REQUIRED"] : []),
    ...(connection?.hasAccessToken === false ? ["EBAY_ACCESS_TOKEN_MISSING"] : []),
    ...(accessTokenExpired && !connection?.hasRefreshToken ? ["EBAY_TOKEN_EXPIRED_NO_REFRESH"] : []),
  ];
  return {
    clientCredentialsConfigured,
    marketplaceId,
    connectionPresent: Boolean(connection),
    connectionStatus: connection?.status ?? null,
    accessTokenPresent: connection?.hasAccessToken ?? false,
    refreshTokenPresent: connection?.hasRefreshToken ?? false,
    accessTokenExpired,
    analyticsScopePresent,
    reconsentRequired,
    collectorReady: blockers.length === 0,
    blockers,
  };
}

export async function collectEbayAnalytics(db: DbClient, options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: Date } = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const readiness = getEbayAnalyticsReadiness(db, env, now);
  if (!readiness.clientCredentialsConfigured || !readiness.marketplaceId) throw new ExternalCollectorError("not_configured", readiness.blockers.join(","));
  if (readiness.reconsentRequired) throw new ExternalCollectorError("permission", "ANALYTICS_RECONSENT_REQUIRED");
  if (!readiness.collectorReady) throw new ExternalCollectorError("not_connected", readiness.blockers.join(","));

  if (readiness.accessTokenExpired) {
    try {
      await refreshConnection(db, PublishChannel.Ebay, new EbayAdapter(env, options.fetchImpl));
    } catch (error) {
      const reconsent = getEbayAnalyticsReadiness(db, env, now).connectionStatus === "revoked";
      throw new ExternalCollectorError(reconsent ? "permission" : "authentication", reconsent ? "ANALYTICS_RECONSENT_REQUIRED" : "eBay token refresh failed");
    }
  }

  const collector = new EbayAnalyticsCollector({
    apiBaseUrl: resolveEbayOAuthConfig(env)!.apiBaseUrl,
    marketplaceId: readiness.marketplaceId,
    listingIds: createSqliteAnalyticsSnapshotRepository(db).listExternalListingIds(PublishChannel.Ebay),
    fetchImpl: options.fetchImpl,
  });
  return runExternalAnalyticsCollection(db, collector, { now });
}
