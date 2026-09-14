import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { marketplaceConnections } from "../../db/schema";
import { decryptCredential, encryptCredential } from "../../services/credentialEncryption";

export type WooCommerceConnectionStatus = "configured" | "verified" | "error";
export type WooCommerceClientErrorKind = "configuration" | "authentication" | "authorization" | "timeout" | "rate_limit" | "remote_validation" | "not_found" | "provider";
export interface WooCommerceTransport { request(input: { method: "GET"; url: string; headers: Record<string, string> }): Promise<{ status: number; body?: unknown }> }
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
    catch (error) { throw new WooCommerceClientError("timeout", error instanceof Error ? error.message : "WooCommerce request failed"); }
    if (response.status === 401) throw new WooCommerceClientError("authentication", "WooCommerce authentication failed");
    if (response.status === 403) throw new WooCommerceClientError("authorization", "WooCommerce authorization failed");
    if (response.status === 429) throw new WooCommerceClientError("rate_limit", "WooCommerce rate limit reached");
    if (response.status < 200 || response.status >= 300) throw new WooCommerceClientError("provider", "WooCommerce verification failed");
    return { verified: true as const };
  }
}

const CHANNEL = "woocommerce";
function safe(row: any): SafeWooCommerceConnection { return { id: row.id, accountLabel: row.accountLabel, storeUrl: row.externalAccountId, credentialMode: "consumer_key_secret", status: row.status, ...(row.lastError ? { lastError: row.lastError } : {}), createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt }; }

export async function saveWooCommerceConnection(db: DbClient, input: { accountLabel?: string; storeUrl: string; consumerKey: string; consumerSecret: string }) {
  const accountLabel = input.accountLabel?.trim() || "Default";
  if (!input.consumerKey.trim() || !input.consumerSecret.trim()) throw new WooCommerceClientError("configuration", "WooCommerce credentials are required");
  const storeUrl = normalizeWooCommerceStoreUrl(input.storeUrl), now = new Date().toISOString();
  const [existing] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, CHANNEL));
  const values = { channel: CHANNEL, accountLabel, externalAccountId: storeUrl, encryptedAccessToken: encryptCredential(input.consumerKey), encryptedRefreshToken: encryptCredential(input.consumerSecret), scopes: JSON.stringify(["read_write"]), status: "configured", lastError: null, updatedAt: now };
  if (existing) await db.update(marketplaceConnections).set(values).where(eq(marketplaceConnections.id, existing.id));
  else await db.insert(marketplaceConnections).values({ id: `conn_${randomUUID()}`, ...values, createdAt: now });
  const [row] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, CHANNEL));
  return safe(row);
}

export async function getWooCommerceConnection(db: DbClient) { const [row] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, CHANNEL)); return row ? safe(row) : undefined; }

export async function verifyWooCommerceConnection(db: DbClient, transport: WooCommerceTransport) {
  const [row] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, CHANNEL));
  if (!row?.encryptedAccessToken || !row.encryptedRefreshToken || !row.externalAccountId) throw new WooCommerceClientError("configuration", "WooCommerce connection is not configured");
  try {
    await new WooCommerceClient({ storeUrl: row.externalAccountId, consumerKey: decryptCredential(row.encryptedAccessToken), consumerSecret: decryptCredential(row.encryptedRefreshToken) }, transport).verify();
    await db.update(marketplaceConnections).set({ status: "verified", lastError: null, updatedAt: new Date().toISOString() }).where(eq(marketplaceConnections.id, row.id));
  } catch (error) {
    const message = error instanceof WooCommerceClientError ? error.message : "WooCommerce verification failed";
    await db.update(marketplaceConnections).set({ status: "error", lastError: message, updatedAt: new Date().toISOString() }).where(eq(marketplaceConnections.id, row.id));
    throw error;
  }
  return (await getWooCommerceConnection(db))!;
}
