import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { marketplaceConnections } from "../../db/schema";
import { decryptCredential, encryptCredential } from "../../services/credentialEncryption";
import type { WooCommerceProductDraft } from "./productAdapter";
import { resolveMarketplaceRequestTimeoutMs } from "../../config/marketplaceConfig";

export type WooCommerceConnectionStatus = "configured" | "verified" | "error";
export type WooCommerceClientErrorKind = "configuration" | "authentication" | "authorization" | "timeout" | "rate_limit" | "remote_validation" | "not_found" | "malformed_response" | "provider";
export interface WooCommerceTransport { request(input: { method: "GET" | "POST" | "PUT"; url: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body?: unknown }> }
export interface SafeWooCommerceConnection { id: string; accountLabel: string; storeUrl: string; credentialMode: "consumer_key_secret"; status: WooCommerceConnectionStatus; lastError?: string; createdAt: string; updatedAt: string }

export class WooCommerceClientError extends Error { constructor(readonly kind: WooCommerceClientErrorKind, message: string) { super(message); this.name = "WooCommerceClientError"; } }

export function normalizeWooCommerceStoreUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new WooCommerceClientError("configuration", "WooCommerce store URL is invalid"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WooCommerceClientError("configuration", "WooCommerce store URL must use HTTP or HTTPS");
  if (url.username || url.password || !url.hostname) throw new WooCommerceClientError("configuration", "WooCommerce store URL is invalid");
  url.hash = ""; url.search = ""; url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export class WooCommerceClient {
  constructor(private readonly config: { storeUrl: string; consumerKey: string; consumerSecret: string }, private readonly transport: WooCommerceTransport) {}
  async verify() {
    const storeUrl = normalizeWooCommerceStoreUrl(this.config.storeUrl);
    if (!this.config.consumerKey || !this.config.consumerSecret) throw new WooCommerceClientError("configuration", "WooCommerce credentials are required");
    let response;
    try { response = await this.transport.request({ method: "GET", url: `${storeUrl}/wp-json/wc/v3/system_status`, headers: { Authorization: `Basic ${Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString("base64")}` } }); }
    catch { throw new WooCommerceClientError("timeout", "WooCommerce request timed out or was unavailable"); }
    if (response.status === 401) throw new WooCommerceClientError("authentication", "WooCommerce authentication failed");
    if (response.status === 403) throw new WooCommerceClientError("authorization", "WooCommerce authorization failed");
    if (response.status === 429) throw new WooCommerceClientError("rate_limit", "WooCommerce rate limit reached");
    if (response.status === 400 || response.status === 422) throw new WooCommerceClientError("remote_validation", "WooCommerce rejected the verification request");
    if (response.status === 404) throw new WooCommerceClientError("not_found", "WooCommerce API endpoint was not found");
    if (response.status < 200 || response.status >= 300) throw new WooCommerceClientError("provider", "WooCommerce verification failed");
    return { verified: true as const };
  }

  async createProduct(payload: WooCommerceProductDraft) { return this.publishRequest("POST", undefined, payload); }
  async updateProduct(externalProductId: string, payload: WooCommerceProductDraft) {
    if (!externalProductId.trim()) throw new WooCommerceClientError("configuration", "WooCommerce Product identity is required");
    return this.publishRequest("PUT", externalProductId, payload);
  }

  private async publishRequest(method: "POST" | "PUT", externalProductId: string | undefined, payload: WooCommerceProductDraft) {
    const storeUrl = normalizeWooCommerceStoreUrl(this.config.storeUrl);
    if (!this.config.consumerKey || !this.config.consumerSecret) throw new WooCommerceClientError("configuration", "WooCommerce credentials are required");
    const suffix = externalProductId ? `/${encodeURIComponent(externalProductId)}` : "";
    let response: Awaited<ReturnType<WooCommerceTransport["request"]>>;
    try {
      response = await this.transport.request({ method, url: `${storeUrl}/wp-json/wc/v3/products${suffix}`, headers: { Authorization: `Basic ${Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString("base64")}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch { throw new WooCommerceClientError("timeout", "WooCommerce request timed out or was unavailable"); }
    if (response.status === 401) throw new WooCommerceClientError("authentication", "WooCommerce authentication failed");
    if (response.status === 403) throw new WooCommerceClientError("authorization", "WooCommerce authorization failed");
    if (response.status === 429) throw new WooCommerceClientError("rate_limit", "WooCommerce rate limit reached");
    if (response.status === 400 || response.status === 422) throw new WooCommerceClientError("remote_validation", "WooCommerce rejected the Product request");
    if (response.status === 404) throw new WooCommerceClientError("not_found", "WooCommerce Product endpoint was not found");
    if (response.status < 200 || response.status >= 300) throw new WooCommerceClientError("provider", "WooCommerce Product request failed");
    const body = response.body as Record<string, unknown> | undefined;
    if (!body || (typeof body.id !== "string" && typeof body.id !== "number")) throw new WooCommerceClientError("malformed_response", "WooCommerce response did not include a Product identity");
    const id = String(body.id);
    return { externalListingId: id, externalListingUrl: typeof body.permalink === "string" ? body.permalink : undefined, externalStatus: typeof body.status === "string" ? body.status : "publish", raw: body };
  }
}

export function createWooCommerceFetchTransport(fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): WooCommerceTransport {
  return { async request(input) { const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), resolveMarketplaceRequestTimeoutMs(env)); try { const response = await fetchImpl(input.url, { method: input.method, headers: input.headers, body: input.body, signal: controller.signal }); return { status: response.status, body: await response.json().catch(() => undefined) }; } finally { clearTimeout(timeout); } } };
}

const CHANNEL = "woocommerce";
function safe(row: any): SafeWooCommerceConnection { return { id: row.id, accountLabel: row.accountLabel, storeUrl: row.externalAccountId, credentialMode: "consumer_key_secret", status: row.status, ...(row.lastError ? { lastError: row.lastError } : {}), createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt }; }
const accountWhere = (accountLabel: string) => and(eq(marketplaceConnections.channel, CHANNEL), eq(marketplaceConnections.accountLabel, accountLabel));
function safeError(error: unknown): WooCommerceClientError {
  const kind = error instanceof WooCommerceClientError ? error.kind : "provider";
  const messages: Record<WooCommerceClientErrorKind, string> = { configuration: "WooCommerce connection is not configured correctly", authentication: "WooCommerce authentication failed", authorization: "WooCommerce authorization failed", timeout: "WooCommerce request timed out or was unavailable", rate_limit: "WooCommerce rate limit reached", remote_validation: "WooCommerce rejected the verification request", not_found: "WooCommerce API endpoint was not found", malformed_response: "WooCommerce response was malformed", provider: "WooCommerce verification failed" };
  return new WooCommerceClientError(kind, messages[kind]);
}

export async function saveWooCommerceConnection(db: DbClient, input: { accountLabel?: string; storeUrl: string; consumerKey: string; consumerSecret: string }) {
  const accountLabel = input.accountLabel?.trim() || "Default";
  if (!input.consumerKey.trim() || !input.consumerSecret.trim()) throw new WooCommerceClientError("configuration", "WooCommerce credentials are required");
  const storeUrl = normalizeWooCommerceStoreUrl(input.storeUrl), now = new Date().toISOString();
  const [existing] = await db.select().from(marketplaceConnections).where(accountWhere(accountLabel));
  const values = { channel: CHANNEL, accountLabel, externalAccountId: storeUrl, encryptedAccessToken: encryptCredential(input.consumerKey), encryptedRefreshToken: encryptCredential(input.consumerSecret), scopes: JSON.stringify(["read_write"]), status: "configured", lastError: null, updatedAt: now };
  if (existing) await db.update(marketplaceConnections).set(values).where(eq(marketplaceConnections.id, existing.id));
  else {
    try { await db.insert(marketplaceConnections).values({ id: `conn_${randomUUID()}`, ...values, createdAt: now }); }
    catch (error) {
      const [raceWinner] = await db.select().from(marketplaceConnections).where(accountWhere(accountLabel));
      if (!raceWinner) throw error;
      await db.update(marketplaceConnections).set(values).where(eq(marketplaceConnections.id, raceWinner.id));
    }
  }
  const [row] = await db.select().from(marketplaceConnections).where(accountWhere(accountLabel));
  return safe(row);
}

export async function getWooCommerceConnection(db: DbClient, accountLabel = "Default") { const [row] = await db.select().from(marketplaceConnections).where(accountWhere(accountLabel.trim() || "Default")); return row ? safe(row) : undefined; }

export async function verifyWooCommerceConnection(db: DbClient, transport: WooCommerceTransport, accountLabel = "Default") {
  const identity = accountLabel.trim() || "Default";
  const [row] = await db.select().from(marketplaceConnections).where(accountWhere(identity));
  if (!row?.encryptedAccessToken || !row.encryptedRefreshToken || !row.externalAccountId) throw new WooCommerceClientError("configuration", "WooCommerce connection is not configured");
  try {
    await new WooCommerceClient({ storeUrl: row.externalAccountId, consumerKey: decryptCredential(row.encryptedAccessToken), consumerSecret: decryptCredential(row.encryptedRefreshToken) }, transport).verify();
    await db.update(marketplaceConnections).set({ status: "verified", lastError: null, updatedAt: new Date().toISOString() }).where(eq(marketplaceConnections.id, row.id));
  } catch (error) {
    const normalized = safeError(error);
    await db.update(marketplaceConnections).set({ status: "error", lastError: normalized.message, updatedAt: new Date().toISOString() }).where(eq(marketplaceConnections.id, row.id));
    throw normalized;
  }
  return (await getWooCommerceConnection(db, identity))!;
}
