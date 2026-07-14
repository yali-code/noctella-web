import { PublishChannel, type MarketplaceApiError, type PublishPayload } from "@noctella/shared";

export interface MarketplaceTokens { accessToken: string; refreshToken?: string; expiresAt?: string; scopes?: string[]; externalAccountId?: string; }
export interface AdapterListingResult { externalListingId: string; externalListingUrl?: string; externalStatus: string; raw?: unknown; }
export interface MarketplaceAdapter {
  getAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<MarketplaceTokens>;
  refreshAccessToken(refreshToken: string): Promise<MarketplaceTokens>;
  verifyConnection(accessToken: string): Promise<{ externalAccountId?: string; raw?: unknown }>;
  createListing(accessToken: string, payload: PublishPayload): Promise<AdapterListingResult>;
  updateListing(accessToken: string, externalListingId: string, payload: PublishPayload): Promise<AdapterListingResult>;
  endListing(accessToken: string, externalListingId: string): Promise<AdapterListingResult>;
  normalizeError(error: unknown): MarketplaceApiError;
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController(); const t = setTimeout(() => controller.abort(), timeoutMs);
  try { const res = await fetch(url, { ...init, signal: controller.signal }); const body = await res.json().catch(() => ({})); if (!res.ok) throw { status: res.status, body }; return body as Record<string, unknown>; } finally { clearTimeout(t); }
}

abstract class HttpAdapter implements MarketplaceAdapter {
  constructor(protected env: Record<string,string|undefined>, protected prefix: "EBAY"|"ETSY") {}
  protected timeout() { return Number(this.env.MARKETPLACE_REQUEST_TIMEOUT_MS ?? 10000); }
  protected base() { return this.env[`${this.prefix}_API_BASE_URL`] ?? (this.prefix === "EBAY" ? "https://api.ebay.com" : "https://api.etsy.com"); }
  protected clientId() { return this.env[`${this.prefix}_CLIENT_ID`] ?? ""; }
  protected redirect() { return this.env[`${this.prefix}_REDIRECT_URI`] ?? ""; }
  getAuthorizationUrl(state: string) { const u = new URL(this.prefix === "EBAY" ? "https://auth.ebay.com/oauth2/authorize" : "https://www.etsy.com/oauth/connect"); u.searchParams.set("client_id", this.clientId()); u.searchParams.set("redirect_uri", this.redirect()); u.searchParams.set("response_type", "code"); u.searchParams.set("state", state); return u.toString(); }
  async exchangeAuthorizationCode(code: string) { return { accessToken: `exchanged-${code}`, refreshToken: `refresh-${code}`, expiresAt: new Date(Date.now()+3600_000).toISOString() }; }
  async refreshAccessToken(refreshToken: string) { return { accessToken: `refreshed-${refreshToken}`, refreshToken, expiresAt: new Date(Date.now()+3600_000).toISOString() }; }
  async verifyConnection(accessToken: string) { const raw = await requestJson(`${this.base()}/identity/v1/me`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { externalAccountId: String(raw.id ?? raw.account_id ?? ""), raw }; }
  async createListing(accessToken: string, payload: PublishPayload) { const raw = await requestJson(`${this.base()}/sell/listing`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type":"application/json" }, body: JSON.stringify(payload) }, this.timeout()); return { externalListingId: String(raw.id ?? raw.listing_id), externalListingUrl: typeof raw.url === "string" ? raw.url : undefined, externalStatus: String(raw.status ?? "active"), raw }; }
  async updateListing(accessToken: string, id: string, payload: PublishPayload) { const raw = await requestJson(`${this.base()}/sell/listing/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type":"application/json" }, body: JSON.stringify(payload) }, this.timeout()); return { externalListingId: id, externalListingUrl: typeof raw.url === "string" ? raw.url : undefined, externalStatus: String(raw.status ?? "active"), raw }; }
  async endListing(accessToken: string, id: string) { const raw = await requestJson(`${this.base()}/sell/listing/${id}/end`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { externalListingId: id, externalListingUrl: typeof raw.url === "string" ? raw.url : undefined, externalStatus: "ended", raw }; }
  normalizeError(error: unknown): MarketplaceApiError { const e = error as { status?: number; message?: string; name?: string }; const type = e.name === "AbortError" ? "Timeout" : e.status === 401 ? "Authentication" : e.status === 403 ? "Authorization" : e.status === 429 ? "RateLimit" : e.status && e.status >= 500 ? "Temporary" : e.status && e.status >= 400 ? "Permanent" : "Unknown"; return { type, code: e.status ? String(e.status) : undefined, message: type, retryable: ["RateLimit","Timeout","Temporary","Unknown"].includes(type) }; }
}
export class EbayAdapter extends HttpAdapter { constructor(env=process.env){ super(env,"EBAY"); } }
export class EtsyAdapter extends HttpAdapter { constructor(env=process.env){ super(env,"ETSY"); } }
export function getMarketplaceAdapter(channel: PublishChannel): MarketplaceAdapter { if (channel === PublishChannel.Ebay) return new EbayAdapter(); if (channel === PublishChannel.Etsy) return new EtsyAdapter(); throw new Error("Unsupported marketplace channel"); }
