// @vitest-environment node
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-stage3b";
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "scheduler-token-stage3b";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { PublishChannel } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { EbayAnalyticsCollector } from "../src/integrations/ebay/ebayAnalyticsCollector";
import { buildEbayAuthorizationUrl, EBAY_ANALYTICS_SCOPE, EbayOAuthError, exchangeEbayAuthorizationCode, refreshEbayAccessToken } from "../src/integrations/ebay/ebayOAuth";
import { decryptCredential, encryptCredential } from "../src/services/credentialEncryption";
import { collectEbayAnalytics, getEbayAnalyticsReadiness } from "../src/services/ebayAnalytics";
import { EbayAdapter } from "../src/services/marketplaceAdapters";
import { completeConnect, getConnection, refreshConnection, startConnect } from "../src/services/marketplacePublishing";
import { createOAuthState } from "../src/services/oauthState";

/**
 * Stage 3B: real eBay OAuth + Sell Analytics traffic-report collector, exercised only through a
 * fake HTTP transport - never live eBay.
 */

const NOW = new Date("2026-10-01T15:30:00.000Z");
const SECRET = "client-secret-value-xyz";
const ENV = { EBAY_CLIENT_ID: "noctella-client-id", EBAY_CLIENT_SECRET: SECRET, EBAY_REDIRECT_URI: "Noctella-RuName", EBAY_ANALYTICS_MARKETPLACE_ID: "EBAY_DE" };

type Call = { url: string; init: RequestInit };
function fakeFetch(...responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const tokenBody = (accessToken: string, refreshToken?: string) => ({ access_token: accessToken, expires_in: 7200, token_type: "User Access Token", ...(refreshToken ? { refresh_token: refreshToken, refresh_token_expires_in: 47304000 } : {}) });

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
function seedConnection(db: any, values: { scopes: string[]; tokenExpiresAt?: string; status?: string; refresh?: boolean }) {
  db.insert(schema.marketplaceConnections).values({ id: "conn-1", channel: "ebay", accountLabel: "Default", status: values.status ?? "connected", encryptedAccessToken: encryptCredential("access-token-1"), encryptedRefreshToken: values.refresh === false ? null : encryptCredential("refresh-token-1"), tokenExpiresAt: values.tokenExpiresAt ?? "2026-10-01T17:00:00.000Z", scopes: JSON.stringify(values.scopes) }).run();
}
function seedListings(db: any) {
  const t = "2026-01-01T00:00:00.000Z";
  db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Clock", slug: "clock", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
  db.insert(schema.externalListings).values({ id: "el-1", productId: "p-1", channel: "ebay", connectionId: "conn-1", externalListingId: "L-1", externalStatus: "active", payloadSnapshot: "{}", publishedAt: t }).run();
  db.insert(schema.externalListings).values({ id: "el-2", productId: "p-1", channel: "ebay", connectionId: "conn-1", externalListingId: "L-2", externalStatus: "ended", payloadSnapshot: "{}", publishedAt: t }).run();
}
const METRIC_KEYS = ["LISTING_IMPRESSION_TOTAL", "LISTING_VIEWS_TOTAL", "CLICK_THROUGH_RATE", "SALES_CONVERSION_RATE", "TRANSACTION"];
const report = (records: Array<{ id: string; values: Array<{ value?: unknown; applicable: boolean }> }>) => ({
  header: { dimensionKeys: [{ key: "LISTING_ID", dataType: "STRING" }], metrics: METRIC_KEYS.map((key) => ({ key, dataType: "NUMBER" })) },
  records: records.map((r) => ({ dimensionValues: [{ value: r.id, applicable: true }], metricValues: r.values })),
  startDate: "2026-09-29T07:00:00.000Z", endDate: "2026-09-30T07:00:00.000Z",
});
const snapshotRows = (sqlite: Database.Database) => sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE source_type = 'external_platform' ORDER BY scope_id, metric_key").all() as any[];

describe("Stage 3B eBay OAuth", () => {
  it("consent URL carries client_id, RuName, response_type=code, the analytics scope and state", () => {
    const url = new URL(buildEbayAuthorizationUrl(ENV, "signed-state"));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.ebay.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "noctella-client-id", redirect_uri: "Noctella-RuName", response_type: "code", scope: EBAY_ANALYTICS_SCOPE, state: "signed-state" });
    expect(new EbayAdapter(ENV).getAuthorizationUrl("s")).toContain(encodeURIComponent(EBAY_ANALYTICS_SCOPE));
    expect(() => buildEbayAuthorizationUrl({}, "s")).toThrow(EbayOAuthError);
  });

  it("authorization-code exchange sends the documented token request and parses the response", async () => {
    const http = fakeFetch({ status: 200, body: tokenBody("new-access", "new-refresh") });
    const tokens = await exchangeEbayAuthorizationCode(ENV, "auth-code-1", http.impl, NOW);
    const [call] = http.calls;
    expect(call!.url).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`noctella-client-id:${SECRET}`).toString("base64")}` });
    expect(Object.fromEntries(new URLSearchParams(String(call!.init.body)))).toEqual({ grant_type: "authorization_code", code: "auth-code-1", redirect_uri: "Noctella-RuName" });
    expect(tokens).toEqual({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: "2026-10-01T17:30:00.000Z", scopes: [EBAY_ANALYTICS_SCOPE] });
  });

  it("refresh sends grant_type=refresh_token with the stored consented scopes", async () => {
    const http = fakeFetch({ status: 200, body: tokenBody("refreshed-access") });
    const tokens = await refreshEbayAccessToken(ENV, "refresh-token-1", [EBAY_ANALYTICS_SCOPE], http.impl, NOW);
    expect(Object.fromEntries(new URLSearchParams(String(http.calls[0]!.init.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-token-1", scope: EBAY_ANALYTICS_SCOPE });
    expect(tokens.refreshToken).toBeUndefined();
  });

  it("refreshConnection works for an expired access token and keeps the existing refresh token when none is returned", async () => {
    const { db } = memoryDb();
    seedConnection(db, { scopes: [EBAY_ANALYTICS_SCOPE], tokenExpiresAt: "2026-01-01T00:00:00.000Z" });
    const http = fakeFetch({ status: 200, body: tokenBody("refreshed-access") });
    await refreshConnection(db, PublishChannel.Ebay, new EbayAdapter(ENV, http.impl));
    const row = db.select().from(schema.marketplaceConnections).get();
    expect(decryptCredential(row.encryptedAccessToken)).toBe("refreshed-access");
    expect(decryptCredential(row.encryptedRefreshToken)).toBe("refresh-token-1");
    expect(row.status).toBe("connected");
  });

  it("a rejected refresh token (invalid_grant) marks the connection revoked - reconnect required, no retry loop", async () => {
    const { db } = memoryDb();
    seedConnection(db, { scopes: [EBAY_ANALYTICS_SCOPE], tokenExpiresAt: "2026-01-01T00:00:00.000Z" });
    const http = fakeFetch({ status: 400, body: { error: "invalid_grant", error_description: "refresh-token-1 is revoked" } });
    await expect(refreshConnection(db, PublishChannel.Ebay, new EbayAdapter(ENV, http.impl))).rejects.toThrow(/reconnect required/);
    expect(http.calls).toHaveLength(1);
    expect(db.select().from(schema.marketplaceConnections).get()).toMatchObject({ status: "revoked", lastError: "RECONSENT_REQUIRED" });
  });

  it("state validation is enforced before any token exchange; a valid connect stores encrypted tokens and the analytics scope", async () => {
    const { db } = memoryDb();
    const http = fakeFetch({ status: 200, body: tokenBody("access-x", "refresh-x") });
    const adapter = new EbayAdapter(ENV, http.impl);
    await expect(completeConnect(db, PublishChannel.Ebay, "code", "forged.state", "", "Default", adapter)).rejects.toThrow(/state/i);
    await expect(completeConnect(db, PublishChannel.Ebay, "code", createOAuthState(PublishChannel.Ebay, "Default", -1), "", "Default", adapter)).rejects.toThrow(/expired/i);
    expect(http.calls).toHaveLength(0);
    const { state } = await startConnect(PublishChannel.Ebay, "Default", adapter);
    const connection = await completeConnect(db, PublishChannel.Ebay, "code", state, "", "Default", adapter);
    expect(connection.scopes).toEqual([EBAY_ANALYTICS_SCOPE]);
    expect(JSON.stringify(connection)).not.toMatch(/access-x|refresh-x/);
    const row = db.select().from(schema.marketplaceConnections).get();
    expect(row.encryptedAccessToken).not.toContain("access-x");
    expect(decryptCredential(row.encryptedAccessToken)).toBe("access-x");
  });

  it("provider errors and readiness never expose secrets or tokens", async () => {
    const http = fakeFetch({ status: 401, body: { error: "invalid_client", error_description: `bad ${SECRET} refresh-token-1` } });
    const error = await exchangeEbayAuthorizationCode(ENV, "code", http.impl).catch((e) => e);
    expect(error).toBeInstanceOf(EbayOAuthError);
    expect(error.kind).toBe("authentication");
    expect(String(error.message)).not.toContain(SECRET);
    expect(String(error.message)).not.toContain("refresh-token-1");
    const { db } = memoryDb();
    seedConnection(db, { scopes: [EBAY_ANALYTICS_SCOPE] });
    const readiness = JSON.stringify(getEbayAnalyticsReadiness(db, ENV, NOW));
    expect(readiness).not.toMatch(new RegExp(`${SECRET}|access-token-1|refresh-token-1`));
    expect(JSON.stringify(await getConnection(db, PublishChannel.Ebay))).not.toMatch(/access-token-1|refresh-token-1/);
  });
});

describe("Stage 3B eBay analytics collector", () => {
  it("an under-scoped (pre-analytics) connection reports ANALYTICS_RECONSENT_REQUIRED and eBay is never called", async () => {
    const { db } = memoryDb();
    seedConnection(db, { scopes: [] });
    expect(getEbayAnalyticsReadiness(db, ENV, NOW)).toMatchObject({ reconsentRequired: true, analyticsScopePresent: false, collectorReady: false, blockers: ["ANALYTICS_RECONSENT_REQUIRED"] });
    const http = fakeFetch();
    await expect(collectEbayAnalytics(db, { env: ENV, fetchImpl: http.impl, now: NOW })).rejects.toMatchObject({ kind: "permission", message: "ANALYTICS_RECONSENT_REQUIRED" });
    expect(http.calls).toHaveLength(0);
  });

  it("collects one batched LISTING traffic report, maps listings via external_listings, keeps missing values unknown, and retries idempotently", async () => {
    const { sqlite, db } = memoryDb();
    seedConnection(db, { scopes: [EBAY_ANALYTICS_SCOPE] });
    seedListings(db);
    expect(getEbayAnalyticsReadiness(db, ENV, NOW)).toMatchObject({ collectorReady: true, blockers: [] });
    const body = report([{ id: "L-1", values: [{ value: 120, applicable: true }, { value: 9, applicable: true }, { value: 7.5, applicable: true }, { applicable: false }, { value: "1", applicable: true }] }]);
    const http = fakeFetch({ status: 200, body });
    const { run, warnings } = await collectEbayAnalytics(db, { env: ENV, fetchImpl: http.impl, now: NOW });

    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.ebay.com/sell/analytics/v1/traffic_report");
    expect(url.searchParams.get("dimension")).toBe("LISTING");
    expect(url.searchParams.get("filter")).toBe("marketplace_ids:{EBAY_DE},date_range:[20260929..20260929],listing_ids:{L-1|L-2}");
    expect(url.searchParams.get("metric")).toBe(METRIC_KEYS.join(","));
    expect(http.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer access-token-1" });

    expect(run).toMatchObject({ status: "completed", sourceType: "external_platform", sourceReference: "ebay.sell.analytics.v1.traffic_report:LISTING:EBAY_DE", observedAt: "2026-09-29", metricCount: 10 });
    expect(warnings).toEqual(["MISSING_TRAFFIC_RECORD:L-2"]);
    const rows = snapshotRows(sqlite);
    const l1 = Object.fromEntries(rows.filter((r) => r.scope_id === "ebay:L-1").map((r) => [r.metric_key, [r.numeric_value, r.value_state, r.unit]]));
    expect(l1).toEqual({
      listing_impressions: [120, "known", "count"],
      listing_views: [9, "known", "count"],
      click_through_rate: [7.5, "known", "provider_defined"],
      conversion_rate: [null, "unknown", "provider_defined"],
      transactions: [1, "known", "count"],
    });
    expect(rows.filter((r) => r.scope_id === "ebay:L-2").every((r) => r.numeric_value === null && r.value_state === "unknown")).toBe(true);
    const meta = JSON.parse(rows.find((r) => r.scope_id === "ebay:L-1" && r.metric_key === "click_through_rate").metadata_json);
    expect(meta).toEqual({ platform: "ebay", connectionId: "conn-1", externalListingId: "L-1", productId: "p-1", providerMetric: "CLICK_THROUGH_RATE", windowSemantics: "fixed_range", window: { start: "2026-09-29", end: "2026-09-29" } });
    expect(JSON.stringify(rows)).not.toContain("access-token-1");

    const retry = await collectEbayAnalytics(db, { env: ENV, fetchImpl: fakeFetch({ status: 200, body }).impl, now: new Date("2026-10-01T16:00:00.000Z") });
    expect(retry).toMatchObject({ replayed: true, run: { id: run.id } });
    expect(snapshotRows(sqlite)).toHaveLength(10);
  });

  it.each([
    [401, "authentication"],
    [403, "permission"],
    [429, "rate_limit"],
    [503, "temporary"],
  ])("HTTP %s from eBay writes no metrics and records a failed %s run", async (status, kind) => {
    const { sqlite, db } = memoryDb();
    seedConnection(db, { scopes: [EBAY_ANALYTICS_SCOPE] });
    seedListings(db);
    await expect(collectEbayAnalytics(db, { env: ENV, fetchImpl: fakeFetch({ status, body: { errors: [{ message: "access-token-1" }] } }).impl, now: NOW })).rejects.toMatchObject({ kind });
    expect(snapshotRows(sqlite)).toHaveLength(0);
    const run = sqlite.prepare("SELECT status, error FROM analytics_runs").get() as any;
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain("access-token-1");
  });

  it("a malformed traffic report is rejected whole", async () => {
    const collector = new EbayAnalyticsCollector({ apiBaseUrl: "https://api.ebay.com", marketplaceId: "EBAY_DE", listingIds: ["L-1"], fetchImpl: fakeFetch({ status: 200, body: { header: { dimensionKeys: [{ key: "DAY" }], metrics: [] }, records: [] } }).impl });
    await expect(collector.collect({ connectionId: "c", accessToken: "t", now: NOW })).rejects.toMatchObject({ kind: "malformed_payload" });
  });
});

describe("Stage 3B scheduler endpoint", () => {
  it("POST /api/background-jobs/analytics-ebay requires scheduler auth and reports not_configured without credentials", async () => {
    const app = (await import("../src/app")).default;
    expect((await request(app).post("/api/background-jobs/analytics-ebay")).status).toBe(401);
    expect((await request(app).post("/api/background-jobs/analytics-ebay").set("Authorization", "Bearer wrong")).status).toBe(401);
    const res = await request(app).post("/api/background-jobs/analytics-ebay").set("Authorization", "Bearer scheduler-token-stage3b");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "not_configured" });
  }, 60_000);
});
