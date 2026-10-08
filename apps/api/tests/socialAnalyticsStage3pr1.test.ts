// @vitest-environment node
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-social";
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "scheduler-token-social";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { INSTAGRAM_INSIGHTS_SCOPE, INSTAGRAM_SCOPES, INSTAGRAM_VAULT_ACCOUNT_ID } from "../src/integrations/instagram/types";
import { buildPinterestAuthorizationUrl, PINTEREST_ANALYTICS_SCOPES } from "../src/integrations/pinterest/pinterestOAuth";
import { decryptCredential, encryptCredential } from "../src/services/credentialEncryption";
import { createOAuthState } from "../src/services/oauthState";
import {
  collectInstagramAnalytics,
  collectPinterestAnalytics,
  completePinterestConnect,
  getSocialAnalyticsReadiness,
  getSocialMetricHistory,
  getSocialPerformance,
} from "../src/services/socialAnalytics";
import { socialHistoryQuerySchema, socialPerformanceQuerySchema } from "../src/use-cases/analytics/socialPerformance";

/**
 * Analytics Stage 3 PR-1: Instagram Insights + Pinterest organic analytics + unified social read
 * model. Every provider call goes through a fake transport - never live Instagram/Pinterest.
 */

const NOW = new Date("2026-10-01T15:30:00.000Z");
const IG_TOKEN = "ig-secret-access-token";
const PIN_TOKEN = "pin-secret-access-token";
const ENV = { INSTAGRAM_API_VERSION: "v23.0", PINTEREST_CLIENT_ID: "pin-client", PINTEREST_CLIENT_SECRET: "pin-client-secret-xyz", PINTEREST_REDIRECT_URI: "https://api.example/api/analytics/social/pinterest/callback", STOREFRONT_APP_ORIGIN: "https://shop.example" } as NodeJS.ProcessEnv;

function memoryDb() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  sqlite.pragma("foreign_keys = OFF"); // fixtures only: approval FK targets (prepared image, admin user) are irrelevant here
  const db = drizzle(sqlite, { schema }) as any;
  const t = "2026-01-01T00:00:00.000Z";
  db.insert(schema.categories).values({ id: "cat-1", name: "Clocks", slug: "clocks" }).run();
  db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Brass clock", slug: "brass-clock", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", categoryId: "cat-1", createdAt: t, updatedAt: t }).run();
  return { sqlite, db };
}

function seedInstagram(db: any, scopes: string[] = [...INSTAGRAM_SCOPES, INSTAGRAM_INSIGHTS_SCOPE]) {
  db.insert(schema.marketplaceConnections).values({ id: "ig-conn", channel: "instagram", accountLabel: "vault", externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, status: "connected", encryptedAccessToken: encryptCredential(IG_TOKEN), tokenExpiresAt: "2026-12-01T00:00:00.000Z", scopes: JSON.stringify(scopes) }).run();
  db.insert(schema.socialContents).values({ id: "sc-1", contentType: "post", productId: "p-1" }).run();
  db.insert(schema.socialContentApprovals).values({ id: "ap-1", requestId: "req-1", contentId: "sc-1", preparedImageId: "img-1", contentVersion: 1, approvedByAdminUserId: "admin-1" }).run();
  db.insert(schema.instagramPublishAttempts).values({ id: "at-1", connectionId: "ig-conn", idempotencyKey: "k-1", approvalId: "ap-1", caption: "c", mediaUrl: "https://x/1.jpg", publishedMediaId: "1790001", status: "published", publishedAt: "2026-09-20T10:00:00.000Z" }).run();
  db.insert(schema.instagramPublishAttempts).values({ id: "at-2", connectionId: "ig-conn", idempotencyKey: "k-2", caption: "c", mediaUrl: "https://x/2.jpg", publishedMediaId: "1790002", status: "published", publishedAt: "2026-09-25T10:00:00.000Z" }).run();
  db.insert(schema.instagramPublishAttempts).values({ id: "at-3", connectionId: "ig-conn", idempotencyKey: "k-3", caption: "c", mediaUrl: "https://x/3.jpg", publishedMediaId: "1790003", status: "published", publishedAt: "2026-01-01T10:00:00.000Z" }).run();
}

const insights = (values: Record<string, number>) => ({ data: Object.entries(values).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }], title: name, id: `x/${name}` })) });
const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function igTransport(handler: (mediaId: string, metrics: string[]) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const mediaId = parsed.pathname.split("/")[2]!;
    const r = handler(mediaId, (parsed.searchParams.get("metric") ?? "").split(","));
    return respond(r.status, r.body);
  });
  return { transport, calls };
}
const igRows = (sqlite: Database.Database) => sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE metric_namespace = 'instagram' ORDER BY scope_id, metric_key").all() as any[];

describe("Instagram Insights collector", () => {
  it("maps publishedMediaId through the publish chain, normalizes lifetime metrics, keeps missing values unknown, and never stores the token", async () => {
    const { sqlite, db } = memoryDb();
    seedInstagram(db);
    const ig = igTransport((mediaId) => ({ status: 200, body: mediaId === "1790001" ? insights({ views: 900, reach: 700, likes: 40, comments: 3, shares: 2, total_interactions: 51 }) : insights({ views: 10, reach: 9, likes: 1, comments: 0, saved: 0, shares: 0, total_interactions: 1 }) }));
    const { run, warnings } = await collectInstagramAnalytics(db, { transport: ig.transport, env: ENV, now: NOW });

    expect(ig.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v23.0/1790002/insights", "/v23.0/1790001/insights"]); // within 90 days only, newest first
    expect(ig.calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${IG_TOKEN}` });
    expect(new URL(ig.calls[0]!.url).searchParams.get("metric")).toBe("views,reach,likes,comments,saved,shares,total_interactions");
    expect(run).toMatchObject({ status: "completed", sourceType: "external_platform", sourceReference: "instagram.graph.media_insights:lifetime", observedAt: "2026-10-01", metricCount: 14 });
    expect(warnings).toEqual(["UNMAPPED_MEDIA:instagram:1790002"]);

    const rows = igRows(sqlite);
    const m1 = rows.filter((r) => r.scope_id === "instagram:1790001");
    expect(m1.find((r) => r.metric_key === "media_saves")).toMatchObject({ numeric_value: null, value_state: "unknown" });
    expect(rows.find((r) => r.scope_id === "instagram:1790002" && r.metric_key === "media_saves")).toMatchObject({ numeric_value: 0, value_state: "known" });
    expect(m1[0]).toMatchObject({ scope_type: "external_media", observed_at: "2026-10-01", collected_at: NOW.toISOString(), unit: "count" });
    expect(JSON.parse(m1.find((r) => r.metric_key === "media_reach").metadata_json)).toEqual({
      platform: "instagram", connectionId: "ig-conn", externalEntityId: "1790001", productId: "p-1", providerMetric: "reach", windowSemantics: "cumulative_lifetime", window: null,
      socialContentId: "sc-1", contentType: "post", publishedAt: "2026-09-20T10:00:00.000Z", publishAttemptId: "at-1", mappingBasis: "social_publish_chain",
    });
    expect(JSON.parse(rows.find((r) => r.scope_id === "instagram:1790002").metadata_json)).toMatchObject({ productId: null, socialContentId: null, mappingBasis: "none" });
    expect(JSON.stringify(rows)).not.toContain(IG_TOKEN);

    const retry = await collectInstagramAnalytics(db, { transport: ig.transport, env: ENV, now: new Date("2026-10-01T20:00:00.000Z") });
    expect(retry).toMatchObject({ replayed: true, run: { id: run.id } });
    expect(igRows(sqlite)).toHaveLength(14);
  });

  it("a rejected combined request falls back per metric once; a metric Meta still rejects stays unknown with a warning", async () => {
    const { sqlite, db } = memoryDb();
    seedInstagram(db);
    const ig = igTransport((_id, metrics) => metrics.length > 1 || metrics[0] === "views" ? { status: 400, body: { error: { message: `bad ${IG_TOKEN}` } } } : { status: 200, body: insights({ [metrics[0]!]: 5 }) });
    const { warnings } = await collectInstagramAnalytics(db, { transport: ig.transport, env: ENV, now: NOW });
    expect(warnings).toContain("METRIC_UNSUPPORTED:views");
    expect(igRows(sqlite).find((r) => r.scope_id === "instagram:1790001" && r.metric_key === "media_views")).toMatchObject({ numeric_value: null, value_state: "unknown" });
    expect(igRows(sqlite).find((r) => r.scope_id === "instagram:1790001" && r.metric_key === "media_reach").numeric_value).toBe(5);
  });

  it.each([[401, "authentication"], [403, "permission"], [429, "rate_limit"]])("HTTP %s writes no metrics and records a failed run without the token", async (status, kind) => {
    const { sqlite, db } = memoryDb();
    seedInstagram(db);
    await expect(collectInstagramAnalytics(db, { transport: igTransport(() => ({ status, body: { error: IG_TOKEN } })).transport, env: ENV, now: NOW })).rejects.toMatchObject({ kind });
    expect(igRows(sqlite)).toHaveLength(0);
    const runRow = sqlite.prepare("SELECT status, error FROM analytics_runs").get() as any;
    expect(runRow.status).toBe("failed");
    expect(runRow.error).not.toContain(IG_TOKEN);
  });

  it("a connection without instagram_business_manage_insights requires reconnect and Instagram is never called", async () => {
    const { db } = memoryDb();
    seedInstagram(db, [...INSTAGRAM_SCOPES]);
    expect(getSocialAnalyticsReadiness(db, ENV, NOW).instagram).toMatchObject({ reconnectRequired: true, insightsPermissionPresent: false, collectorReady: false, publishedMediaInWindow: 2 });
    const ig = igTransport(() => ({ status: 200, body: insights({}) }));
    await expect(collectInstagramAnalytics(db, { transport: ig.transport, env: ENV, now: NOW })).rejects.toMatchObject({ kind: "permission" });
    expect(ig.transport).not.toHaveBeenCalled();
  });
});

type Call = { url: string; init: RequestInit };
function pinFetch(handler: (url: URL, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); const r = handler(new URL(String(url)), init); return respond(r.status, r.body); });
  return { impl: impl as unknown as typeof fetch, calls };
}
function seedPinterestConnection(db: any, values: { expiresAt?: string; scopes?: readonly string[] } = {}) {
  db.insert(schema.marketplaceConnections).values({ id: "pin-conn", channel: "pinterest", accountLabel: "Default", status: "connected", encryptedAccessToken: encryptCredential(PIN_TOKEN), encryptedRefreshToken: encryptCredential("pinr-old-refresh"), tokenExpiresAt: values.expiresAt ?? "2026-12-01T00:00:00.000Z", scopes: JSON.stringify(values.scopes ?? PINTEREST_ANALYTICS_SCOPES) }).run();
}
const pinterestApi = (url: URL) => {
  if (url.pathname === "/v5/pins" && !url.searchParams.get("bookmark")) return { status: 200, body: { items: [{ id: "P1", link: "https://shop.example/product/brass-clock", created_at: "2026-09-10T00:00:00" }], bookmark: "page2" } };
  if (url.pathname === "/v5/pins") return { status: 200, body: { items: [{ id: "P2", link: "https://elsewhere.example/product/brass-clock" }, { id: "P3", link: null }], bookmark: null } };
  if (url.pathname === "/v5/pins/analytics") return { status: 200, body: { P1: { all: { summary_metrics: { IMPRESSION: 120, SAVE: 4, PIN_CLICK: 6 }, daily_metrics: [] } }, P2: { all: { summary_metrics: { IMPRESSION: 3, SAVE: 0, PIN_CLICK: 0, OUTBOUND_CLICK: 0 } } } } };
  return { status: 404, body: {} };
};
const pinRows = (sqlite: Database.Database) => sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE metric_namespace = 'pinterest' ORDER BY scope_id, metric_key").all() as any[];

describe("Pinterest OAuth + organic analytics", () => {
  it("consent URL, state-verified code exchange (Basic + form), encrypted storage, sanitized readiness", async () => {
    const url = new URL(buildPinterestAuthorizationUrl(ENV, "signed"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.pinterest.com/oauth/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "pin-client", redirect_uri: ENV.PINTEREST_REDIRECT_URI, response_type: "code", scope: PINTEREST_ANALYTICS_SCOPES.join(","), state: "signed" });

    const { db } = memoryDb();
    const http = pinFetch(() => ({ status: 200, body: { access_token: "pin-new-access", refresh_token: "pinr-new", expires_in: 2592000, scope: "user_accounts:read,boards:read,pins:read", token_type: "bearer" } }));
    await expect(completePinterestConnect(db, "code-1", "forged.state", { env: ENV, fetchImpl: http.impl, now: NOW })).rejects.toMatchObject({ kind: "authentication" });
    expect(http.calls).toHaveLength(0);

    const readiness = await completePinterestConnect(db, "code-1", createOAuthState("pinterest", "Default"), { env: ENV, fetchImpl: http.impl, now: NOW });
    const call = http.calls[0]!;
    expect(call.url).toBe("https://api.pinterest.com/v5/oauth/token");
    expect(call.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from("pin-client:pin-client-secret-xyz").toString("base64")}` });
    expect(Object.fromEntries(new URLSearchParams(String(call.init.body)))).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: ENV.PINTEREST_REDIRECT_URI });
    expect(readiness).toMatchObject({ connectionPresent: true, analyticsScopesPresent: true, consentRequired: false, collectorReady: true });
    expect(JSON.stringify(readiness)).not.toMatch(/pin-new-access|pinr-new|pin-client-secret/);
    const row = db.select().from(schema.marketplaceConnections).get();
    expect(decryptCredential(row.encryptedAccessToken)).toBe("pin-new-access");
  });

  it("discovers Pins, batches multi-Pin analytics, maps only exact storefront product links, keeps missing metrics unknown", async () => {
    const { sqlite, db } = memoryDb();
    seedPinterestConnection(db);
    const http = pinFetch((u) => pinterestApi(u));
    const { run, warnings } = await collectPinterestAnalytics(db, { env: ENV, fetchImpl: http.impl, now: NOW });

    const analyticsCall = new URL(http.calls.find((c) => new URL(c.url).pathname === "/v5/pins/analytics")!.url);
    expect(Object.fromEntries(analyticsCall.searchParams)).toEqual({ pin_ids: "P1,P2,P3", start_date: "2026-09-29", end_date: "2026-09-29", metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK" });
    expect(http.calls.filter((c) => new URL(c.url).pathname === "/v5/pins/analytics")).toHaveLength(1);
    expect(http.calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${PIN_TOKEN}` });
    expect(run).toMatchObject({ status: "completed", sourceReference: "pinterest.v5.pins_analytics:summary", observedAt: "2026-09-29", metricCount: 12 });
    expect(warnings).toEqual(["MISSING_PIN_ANALYTICS:P3", "UNMAPPED_PIN:pinterest:P2", "UNMAPPED_PIN:pinterest:P3"]);

    const rows = pinRows(sqlite);
    expect(rows.find((r) => r.scope_id === "pinterest:P1" && r.metric_key === "pin_outbound_clicks")).toMatchObject({ numeric_value: null, value_state: "unknown" });
    expect(rows.find((r) => r.scope_id === "pinterest:P2" && r.metric_key === "pin_saves")).toMatchObject({ numeric_value: 0, value_state: "known" });
    expect(rows.filter((r) => r.scope_id === "pinterest:P3").every((r) => r.numeric_value === null)).toBe(true);
    expect(JSON.parse(rows.find((r) => r.scope_id === "pinterest:P1").metadata_json)).toMatchObject({ productId: "p-1", mappingBasis: "storefront_product_url", windowSemantics: "fixed_range", window: { start: "2026-09-29", end: "2026-09-29" } });
    expect(JSON.parse(rows.find((r) => r.scope_id === "pinterest:P2").metadata_json)).toMatchObject({ productId: null, mappingBasis: "none" });
    expect(JSON.stringify(rows)).not.toContain(PIN_TOKEN);
  });

  it("403 (e.g. analytics not available to the app) writes no metrics", async () => {
    const { sqlite, db } = memoryDb();
    seedPinterestConnection(db);
    await expect(collectPinterestAnalytics(db, { env: ENV, fetchImpl: pinFetch(() => ({ status: 403, body: { message: PIN_TOKEN } })).impl, now: NOW })).rejects.toMatchObject({ kind: "permission" });
    expect(pinRows(sqlite)).toHaveLength(0);
    expect((sqlite.prepare("SELECT error FROM analytics_runs").get() as any).error).not.toContain(PIN_TOKEN);
  });

  it("an expired token is refreshed (new continuous refresh token stored); invalid_grant revokes the connection", async () => {
    const { db } = memoryDb();
    seedPinterestConnection(db, { expiresAt: "2026-01-01T00:00:00.000Z" });
    const http = pinFetch((u) => (u.pathname === "/v5/oauth/token" ? { status: 200, body: { access_token: "pin-refreshed", refresh_token: "pinr-rotated", expires_in: 2592000 } } : pinterestApi(u)));
    await collectPinterestAnalytics(db, { env: ENV, fetchImpl: http.impl, now: NOW });
    expect(Object.fromEntries(new URLSearchParams(String(http.calls[0]!.init.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "pinr-old-refresh" });
    let row = db.select().from(schema.marketplaceConnections).get();
    expect([decryptCredential(row.encryptedAccessToken), decryptCredential(row.encryptedRefreshToken)]).toEqual(["pin-refreshed", "pinr-rotated"]);

    db.update(schema.marketplaceConnections).set({ tokenExpiresAt: "2026-01-01T00:00:00.000Z" }).run();
    await expect(collectPinterestAnalytics(db, { env: ENV, fetchImpl: pinFetch(() => ({ status: 400, body: { error: "invalid_grant" } })).impl, now: NOW })).rejects.toMatchObject({ kind: "permission" });
    row = db.select().from(schema.marketplaceConnections).get();
    expect(row).toMatchObject({ status: "revoked", lastError: "RECONSENT_REQUIRED" });
  });
});

describe("Unified social performance read model", () => {
  it("keeps platforms' metrics separate, joins mapped products to existing profitability facts (correlation only), stays read-only", async () => {
    const { sqlite, db } = memoryDb();
    seedInstagram(db);
    seedPinterestConnection(db);
    await collectInstagramAnalytics(db, { transport: igTransport(() => ({ status: 200, body: insights({ views: 5, reach: 4, likes: 1, comments: 0, saved: 1, shares: 0, total_interactions: 2 }) })).transport, env: ENV, now: NOW });
    await collectPinterestAnalytics(db, { env: ENV, fetchImpl: pinFetch((u) => pinterestApi(u)).impl, now: NOW });

    const dump = () => ["analytics_runs", "analytics_metric_snapshots", "products", "marketplace_connections", "social_contents", "instagram_publish_attempts"].map((t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = dump();
    const all = getSocialPerformance(db, socialPerformanceQuerySchema.parse({}));
    expect(dump()).toEqual(before);

    expect(all.summary).toEqual({ instagram: { entities: 2, mapped: 1, unmapped: 1 }, pinterest: { entities: 3, mapped: 1, unmapped: 2 } });
    const ig = all.items.find((i) => i.scopeId === "instagram:1790001")!;
    expect(Object.keys(ig.latestMetrics).sort()).toEqual(["media_comments", "media_likes", "media_reach", "media_saves", "media_shares", "media_total_interactions", "media_views"]);
    expect(ig).toMatchObject({ platform: "instagram", entityType: "media", productId: "p-1", socialContentId: "sc-1", contentType: "post", mappingStatus: "mapped", relation: "RELATED", ageDaysAtLatestObservation: 11, product: { sku: "SKU-1", category: "Clocks", saleState: "not_sold", profitStatus: "NOT_SOLD" }, saleObservedAfterPublication: false });
    const pin = all.items.find((i) => i.scopeId === "pinterest:P1")!;
    expect(Object.keys(pin.latestMetrics).sort()).toEqual(["pin_clicks", "pin_impressions", "pin_outbound_clicks", "pin_saves"]);
    expect(pin.metricCompleteness).toEqual({ known: 3, unknown: 1 });
    expect(all.items.find((i) => i.scopeId === "pinterest:P3")).toMatchObject({ mappingStatus: "unmapped", product: null, relation: null, saleObservedAfterPublication: null });

    expect(getSocialPerformance(db, socialPerformanceQuerySchema.parse({ platform: "pinterest", mapped: "false" })).items.map((i) => i.scopeId)).toEqual(["pinterest:P2", "pinterest:P3"]);
    expect(getSocialPerformance(db, socialPerformanceQuerySchema.parse({ category: "Clocks" })).meta.total).toBe(2);
    const history = getSocialMetricHistory(db, socialHistoryQuerySchema.parse({ scopeId: "instagram:1790002", metricKey: "media_reach" }));
    expect(history.items).toEqual([expect.objectContaining({ numericValue: 4, observedAt: "2026-10-01", collectedAt: NOW.toISOString(), sourceType: "external_platform" })]);
    expect(() => socialHistoryQuerySchema.parse({ scopeId: "ebay:L-1" })).toThrow();
  });

  it("routes: social reads require a session; scheduler triggers require the scheduler token and fail closed without config", async () => {
    const app = (await import("../src/app")).default;
    expect((await request(app).get("/api/analytics/social")).status).toBe(401);
    expect((await request(app).get("/api/analytics/social/readiness")).status).toBe(401);
    for (const path of ["analytics-instagram", "analytics-pinterest"]) {
      expect((await request(app).post(`/api/background-jobs/${path}`)).status).toBe(401);
      const res = await request(app).post(`/api/background-jobs/${path}`).set("Authorization", "Bearer scheduler-token-social");
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toMatch(/token|secret/i);
    }
  }, 60_000);
});
