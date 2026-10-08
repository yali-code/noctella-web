import type { DbClient } from "../db/client";
import { marketplaceConnections } from "../db/schema";
import { apiVersion } from "../integrations/instagram/InstagramClient";
import { InstagramInsightsCollector } from "../integrations/instagram/instagramInsightsCollector";
import { INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_CHANNEL, INSTAGRAM_INSIGHTS_SCOPE, INSTAGRAM_SCOPES, type InstagramTransport } from "../integrations/instagram/types";
import { PinterestAnalyticsCollector, type DiscoveredPin } from "../integrations/pinterest/pinterestAnalyticsCollector";
import { buildPinterestAuthorizationUrl, exchangePinterestAuthorizationCode, PINTEREST_ACCOUNT_LABEL, PINTEREST_ANALYTICS_SCOPES, PINTEREST_CHANNEL, PinterestOAuthError, refreshPinterestAccessToken, resolvePinterestOAuthConfig } from "../integrations/pinterest/pinterestOAuth";
import { createSqliteAnalyticsSnapshotRepository } from "../repositories/analytics/analyticsSnapshotsSqlite";
import { createSqliteSocialAnalyticsRepository } from "../repositories/analytics/socialAnalyticsSqlite";
import { parseConfiguredOrigins } from "../auth/originAllowlist";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
import { ExternalCollectorError, type ExternalEntityLink } from "../use-cases/analytics/externalMetrics";
import { buildSocialPerformance, type SocialHistoryQuery, type SocialPerformanceQuery } from "../use-cases/analytics/socialPerformance";
import { decryptCredential, encryptCredential } from "./credentialEncryption";
import { runExternalAnalyticsCollection } from "./externalAnalytics";
import { getCatalogueProfitability } from "./productProfitability";
import { createOAuthState, verifyOAuthState } from "./oauthState";
import { eq } from "drizzle-orm";

/**
 * Analytics Stage 3: social analytics (Instagram Insights + Pinterest organic analytics).
 * Read-only toward every operational table; writes only analytics_runs /
 * analytics_metric_snapshots and (Pinterest consent) the encrypted marketplace_connections row.
 * Readiness is sanitized - booleans/status only, never token values.
 */

/** Bounded Instagram collection: media published within this many days, newest first, capped. */
export const INSTAGRAM_INSIGHTS_MAX_AGE_DAYS = 90;
export const INSTAGRAM_INSIGHTS_MAX_MEDIA = 100;
const DAY_MS = 86_400_000;

const expired = (iso: string | null, now: Date) => (iso ? Date.parse(iso) <= now.getTime() + 60_000 : null);

export function getInstagramAnalyticsReadiness(db: DbClient, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  const connection = createSqliteAnalyticsSnapshotRepository(db).findConnectionSummary(INSTAGRAM_CHANNEL);
  let apiVersionConfigured = true;
  try { apiVersion(env); } catch { apiVersionConfigured = false; }
  const since = new Date(now.getTime() - INSTAGRAM_INSIGHTS_MAX_AGE_DAYS * DAY_MS).toISOString();
  const publishedMediaInWindow = createSqliteSocialAnalyticsRepository(db).countInstagramPublishedMedia(since);
  const permissionsPresent = Boolean(connection) && connection!.scopes.includes(INSTAGRAM_INSIGHTS_SCOPE) && connection!.scopes.includes(INSTAGRAM_SCOPES[0]);
  const tokenExpired = expired(connection?.tokenExpiresAt ?? null, now);
  const reconnectRequired = Boolean(connection) && (!permissionsPresent || tokenExpired === true || connection!.status !== "connected");
  const blockers = [
    ...(apiVersionConfigured ? [] : ["INSTAGRAM_API_VERSION_MISSING"]),
    ...(connection ? [] : ["INSTAGRAM_CONNECTION_MISSING"]),
    ...(connection && !connection.hasAccessToken ? ["INSTAGRAM_ACCESS_TOKEN_MISSING"] : []),
    ...(connection && !permissionsPresent ? ["INSTAGRAM_INSIGHTS_PERMISSION_MISSING"] : []),
    ...(tokenExpired ? ["INSTAGRAM_TOKEN_EXPIRED"] : []),
    ...(connection && connection.status !== "connected" ? [`INSTAGRAM_CONNECTION_${connection.status.toUpperCase()}`] : []),
  ];
  return { connectionPresent: Boolean(connection), accessTokenPresent: connection?.hasAccessToken ?? false, tokenExpired, insightsPermissionPresent: permissionsPresent, apiVersionConfigured, publishedMediaInWindow, reconnectRequired, collectorReady: blockers.length === 0, blockers };
}

export async function collectInstagramAnalytics(db: DbClient, options: { transport?: InstagramTransport; env?: NodeJS.ProcessEnv; now?: Date } = {}) {
  const env = options.env ?? process.env, now = options.now ?? new Date();
  const readiness = getInstagramAnalyticsReadiness(db, env, now);
  if (!readiness.collectorReady) {
    const kind = !readiness.apiVersionConfigured ? "not_configured" : !readiness.connectionPresent ? "not_connected" : "permission";
    throw new ExternalCollectorError(kind, readiness.blockers.join(","));
  }
  const media = createSqliteSocialAnalyticsRepository(db).listInstagramPublishedMedia(new Date(now.getTime() - INSTAGRAM_INSIGHTS_MAX_AGE_DAYS * DAY_MS).toISOString(), INSTAGRAM_INSIGHTS_MAX_MEDIA);
  const links = new Map<string, ExternalEntityLink>(media.map((m) => [m.mediaId, {
    productId: m.productId,
    context: { socialContentId: m.socialContentId, contentType: m.contentType, publishedAt: m.publishedAt, publishAttemptId: m.attemptId, mappingBasis: m.productId ? "social_publish_chain" : "none" },
  }]));
  const collector = new InstagramInsightsCollector({ media: media.map((m) => ({ mediaId: m.mediaId })), transport: options.transport, env });
  return runExternalAnalyticsCollection(db, collector, { now, accountLabel: INSTAGRAM_ACCOUNT_LABEL, resolveEntityLinks: () => links });
}

// ---------------------------------------------------------------- Pinterest consent + collection

export function getPinterestAnalyticsReadiness(db: DbClient, env: Record<string, string | undefined> = process.env, now: Date = new Date()) {
  const connection = createSqliteAnalyticsSnapshotRepository(db).findConnectionSummary(PINTEREST_CHANNEL);
  const credentialsConfigured = resolvePinterestOAuthConfig(env) !== null;
  const scopesPresent = Boolean(connection) && PINTEREST_ANALYTICS_SCOPES.every((s) => connection!.scopes.includes(s));
  const tokenExpired = expired(connection?.tokenExpiresAt ?? null, now);
  const consentRequired = !connection || !scopesPresent || connection.status === "revoked";
  const blockers = [
    ...(credentialsConfigured ? [] : ["PINTEREST_CLIENT_CREDENTIALS_MISSING"]),
    ...(connection ? [] : ["PINTEREST_CONSENT_REQUIRED"]),
    ...(connection && !scopesPresent ? ["PINTEREST_ANALYTICS_SCOPE_MISSING"] : []),
    ...(connection && connection.status !== "connected" ? [`PINTEREST_CONNECTION_${connection.status.toUpperCase()}`] : []),
    ...(tokenExpired && !connection?.hasRefreshToken ? ["PINTEREST_TOKEN_EXPIRED_NO_REFRESH"] : []),
  ];
  return { credentialsConfigured, connectionPresent: Boolean(connection), connectionStatus: connection?.status ?? null, analyticsScopesPresent: scopesPresent, accessTokenPresent: connection?.hasAccessToken ?? false, refreshTokenPresent: connection?.hasRefreshToken ?? false, tokenExpired, consentRequired, collectorReady: blockers.length === 0, blockers };
}

export function startPinterestConnect(env: Record<string, string | undefined> = process.env) {
  const state = createOAuthState(PINTEREST_CHANNEL, PINTEREST_ACCOUNT_LABEL);
  return { authorizationUrl: buildPinterestAuthorizationUrl(env, state) };
}

function saveTokens(db: DbClient, tokens: { accessToken: string; refreshToken?: string; expiresAt: string; scopes: string[] }, existingRefresh: string | null) {
  const t = new Date().toISOString();
  const values = { encryptedAccessToken: encryptCredential(tokens.accessToken), encryptedRefreshToken: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : existingRefresh, tokenExpiresAt: tokens.expiresAt, scopes: JSON.stringify(tokens.scopes), status: "connected", lastError: null, updatedAt: t };
  (db as any).insert(marketplaceConnections).values({ id: `conn_pinterest_${PINTEREST_ACCOUNT_LABEL.toLowerCase()}`, channel: PINTEREST_CHANNEL, accountLabel: PINTEREST_ACCOUNT_LABEL, createdAt: t, ...values })
    .onConflictDoUpdate({ target: [marketplaceConnections.channel, marketplaceConnections.accountLabel], set: values }).run();
}

/** Callback: the signed, expiring, channel-bound state is verified BEFORE the code is exchanged. */
export async function completePinterestConnect(db: DbClient, code: string, state: string, options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: Date } = {}) {
  try { verifyOAuthState(state, PINTEREST_CHANNEL); } catch { throw new PinterestOAuthError("authentication", "state_mismatch"); }
  if (!code || code.length > 2048) throw new PinterestOAuthError("authentication", "invalid_code");
  const tokens = await exchangePinterestAuthorizationCode(options.env ?? process.env, code, options.fetchImpl, options.now);
  saveTokens(db, tokens, null);
  return getPinterestAnalyticsReadiness(db, options.env ?? process.env, options.now);
}

async function refreshPinterestIfExpired(db: DbClient, env: Record<string, string | undefined>, fetchImpl: typeof fetch | undefined, now: Date) {
  const row = (db as any).select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, PINTEREST_CHANNEL)).get();
  if (!row?.tokenExpiresAt || Date.parse(row.tokenExpiresAt) > now.getTime() + 60_000) return;
  if (!row.encryptedRefreshToken) throw new ExternalCollectorError("authentication", "PINTEREST_TOKEN_EXPIRED_NO_REFRESH");
  try {
    saveTokens(db, await refreshPinterestAccessToken(env, decryptCredential(row.encryptedRefreshToken), JSON.parse(row.scopes ?? "[]"), fetchImpl, now), row.encryptedRefreshToken);
  } catch (error) {
    const reconsent = error instanceof PinterestOAuthError && error.requiresReconsent;
    (db as any).update(marketplaceConnections).set(reconsent ? { status: "revoked", lastError: "RECONSENT_REQUIRED", updatedAt: new Date().toISOString() } : { lastError: error instanceof PinterestOAuthError ? `refresh_${error.kind}` : "refresh_failed", updatedAt: new Date().toISOString() }).where(eq(marketplaceConnections.id, row.id)).run();
    throw new ExternalCollectorError(reconsent ? "permission" : "authentication", reconsent ? "PINTEREST_CONSENT_REQUIRED" : "Pinterest token refresh failed");
  }
}

/** Deterministic Pin -> product link: exact storefront origin + /product/<slug> + existing slug. Never guessed. */
export function storefrontProductSlug(link: string | null, storefrontOrigins: readonly string[]): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (!storefrontOrigins.includes(url.origin)) return null;
    const match = /^\/product\/([A-Za-z0-9-]+)\/?$/.exec(url.pathname);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

export async function collectPinterestAnalytics(db: DbClient, options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: Date } = {}) {
  const env = options.env ?? process.env, now = options.now ?? new Date();
  const readiness = getPinterestAnalyticsReadiness(db, env, now);
  if (!readiness.credentialsConfigured) throw new ExternalCollectorError("not_configured", readiness.blockers.join(","));
  if (readiness.consentRequired) throw new ExternalCollectorError("permission", "PINTEREST_CONSENT_REQUIRED");
  if (!readiness.collectorReady) throw new ExternalCollectorError("not_connected", readiness.blockers.join(","));
  await refreshPinterestIfExpired(db, env, options.fetchImpl, now);

  let pins: readonly DiscoveredPin[] = [];
  const collector = new PinterestAnalyticsCollector({ fetchImpl: options.fetchImpl, onPinsDiscovered: (found) => { pins = found; } });
  const origins = parseConfiguredOrigins(env.STOREFRONT_APP_ORIGIN).map((o) => { try { return new URL(o).origin; } catch { return o; } });
  return runExternalAnalyticsCollection(db, collector, {
    now,
    accountLabel: PINTEREST_ACCOUNT_LABEL,
    resolveEntityLinks: () => {
      const slugByPin = new Map(pins.map((p) => [p.id, storefrontProductSlug(p.link, origins)] as const));
      const productBySlug = createSqliteSocialAnalyticsRepository(db).productIdsBySlug([...slugByPin.values()].filter((s): s is string => s !== null));
      return new Map(pins.map((p) => {
        const productId = productBySlug.get(slugByPin.get(p.id) ?? "") ?? null;
        return [p.id, { productId, context: { pinCreatedAt: p.createdAt, mappingBasis: productId ? "storefront_product_url" : "none" } }];
      }));
    },
  });
}

// ---------------------------------------------------------------- read models

export function getSocialPerformance(db: DbClient, query: SocialPerformanceQuery) {
  const rows = createSqliteSocialAnalyticsRepository(db).listSocialSnapshots(["instagram", "pinterest"]);
  const catalogue = getCatalogueProfitability(db, { ...catalogueProfitabilityQuerySchema.parse({}), limit: Number.MAX_SAFE_INTEGER });
  return buildSocialPerformance(rows, new Map(catalogue.items.map((i) => [i.productId, i])), query);
}

export function getSocialMetricHistory(db: DbClient, query: SocialHistoryQuery) {
  const items = createSqliteSocialAnalyticsRepository(db).listScopeHistory(query.scopeId, query).map((r: any) => ({
    metricNamespace: r.metricNamespace, metricKey: r.metricKey, numericValue: r.numericValue, valueState: r.valueState, unit: r.unit,
    sourceType: r.sourceType, sourceReference: r.sourceReference, observedAt: r.observedAt, collectedAt: r.collectedAt, runId: r.runId,
    metadata: r.metadataJson ? JSON.parse(r.metadataJson) : null,
  }));
  return { scopeId: query.scopeId, items, meta: { returned: items.length, limit: query.limit } };
}

export function getSocialAnalyticsReadiness(db: DbClient, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  return { instagram: getInstagramAnalyticsReadiness(db, env, now), pinterest: getPinterestAnalyticsReadiness(db, env, now) };
}
