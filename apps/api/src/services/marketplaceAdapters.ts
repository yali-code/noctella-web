import crypto from "node:crypto";
import { MarketplaceWebhookEventType, PublishChannel, type MarketplaceApiError, type PublishPayload, type ShipmentUpdateResult } from "@noctella/shared";

export interface MarketplaceTokens { accessToken: string; refreshToken?: string; expiresAt?: string; scopes?: string[]; externalAccountId?: string; }
export interface MarketplaceInventoryResult { externalListingId: string; stock: number; raw?: unknown; }
export interface MarketplaceInventoryUpdateResult { externalListingId: string; requestedStock: number; confirmedStock: number; raw?: unknown; }
export interface AdapterListingResult { externalListingId: string; externalListingUrl?: string; externalStatus: string; raw?: unknown; }
export interface NormalizedMarketplaceOrderItem { externalOrderItemId?: string; externalListingId?: string; sku?: string; title: string; quantity: number; unitPrice: number; lineTotal: number; }
export interface NormalizedMarketplaceOrder { externalOrderId: string; externalOrderNumber?: string; status: string; currency: string; subtotal: number; shipping: number; tax: number; total: number; buyerEmail?: string; buyerName?: string; shippingAddress?: unknown; billingAddress?: unknown; orderedAt: string; items: NormalizedMarketplaceOrderItem[]; raw?: unknown; }
export interface ParsedMarketplaceWebhookEvent { externalEventId: string; eventType: MarketplaceWebhookEventType | string; externalOrderId?: string; externalListingId?: string; payload: unknown; }
export interface MarketplaceAdapter {
  getAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<MarketplaceTokens>;
  refreshAccessToken(refreshToken: string): Promise<MarketplaceTokens>;
  verifyConnection(accessToken: string): Promise<{ externalAccountId?: string; raw?: unknown }>;
  createListing(accessToken: string, payload: PublishPayload): Promise<AdapterListingResult>;
  updateListing(accessToken: string, externalListingId: string, payload: PublishPayload): Promise<AdapterListingResult>;
  endListing(accessToken: string, externalListingId: string): Promise<AdapterListingResult>;
  normalizeError(error: unknown): MarketplaceApiError;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<boolean> | boolean;
  parseWebhookEvent(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<ParsedMarketplaceWebhookEvent> | ParsedMarketplaceWebhookEvent;
  fetchOrderById(accessToken: string, externalOrderId: string): Promise<NormalizedMarketplaceOrder>;
  fetchListingStatus(accessToken: string, externalListingId: string): Promise<{ externalListingId: string; externalStatus: string; raw?: unknown }>;
  getListingInventory(accessToken: string, externalListingId: string): Promise<MarketplaceInventoryResult>;
  updateListingInventory(accessToken: string, externalListingId: string, stock: number): Promise<MarketplaceInventoryUpdateResult>;
  listActiveListings?(accessToken: string): Promise<MarketplaceInventoryResult[]>;
  submitShipment(accessToken: string, payload: unknown): Promise<ShipmentUpdateResult & { externalFulfillmentId?: string; raw?: unknown }>;
  updateShipmentTracking(accessToken: string, externalFulfillmentId: string, payload: unknown): Promise<ShipmentUpdateResult & { raw?: unknown }>;
  cancelShipmentFulfillment(accessToken: string, externalFulfillmentId: string): Promise<ShipmentUpdateResult & { raw?: unknown }>;
  fetchShipmentStatus(accessToken: string, externalFulfillmentId: string): Promise<ShipmentUpdateResult & { raw?: unknown }>;
  normalizeShipmentError(error: unknown): MarketplaceApiError;
  normalizeInventoryError(error: unknown): MarketplaceApiError;
  acknowledgeWebhook?(event: ParsedMarketplaceWebhookEvent): Promise<void>;
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
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) { const secret = this.env[`${this.prefix}_WEBHOOK_SECRET`] ?? "test-secret"; const sig = String(headers[`${this.prefix.toLowerCase()}-signature`] ?? headers["x-marketplace-signature"] ?? ""); const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex"); return sig === expected; }
  parseWebhookEvent(rawBody: Buffer) { const payload = JSON.parse(rawBody.toString("utf8") || "{}"); return { externalEventId: String(payload.eventId ?? payload.id ?? payload.externalEventId), eventType: String(payload.type ?? payload.eventType ?? MarketplaceWebhookEventType.Unsupported), externalOrderId: payload.orderId ? String(payload.orderId) : undefined, externalListingId: payload.listingId ? String(payload.listingId) : undefined, payload }; }
  async fetchOrderById(accessToken: string, externalOrderId: string) { const raw = await requestJson(`${this.base()}/orders/${externalOrderId}`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return normalizeOrder(raw, externalOrderId); }
  async getListingInventory(accessToken: string, externalListingId: string) { const raw = await requestJson(`${this.base()}/sell/listing/${externalListingId}/inventory`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { externalListingId, stock: Number(raw.stock ?? raw.quantity ?? raw.available ?? 0), raw }; }
  async updateListingInventory(accessToken: string, externalListingId: string, stock: number) { const raw = await requestJson(`${this.base()}/sell/listing/${externalListingId}/inventory`, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ stock, quantity: stock }) }, this.timeout()); return { externalListingId, requestedStock: stock, confirmedStock: Number(raw.stock ?? raw.quantity ?? raw.available ?? stock), raw }; }
  async listActiveListings(accessToken: string) { const raw = await requestJson(`${this.base()}/sell/listing?status=active`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); const rows = Array.isArray(raw.listings) ? raw.listings as Record<string, unknown>[] : []; return rows.map((row) => ({ externalListingId: String(row.id ?? row.listing_id), stock: Number(row.stock ?? row.quantity ?? 0), raw: row })); }
  async fetchListingStatus(accessToken: string, externalListingId: string) { const raw = await requestJson(`${this.base()}/sell/listing/${externalListingId}`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { externalListingId, externalStatus: String(raw.status ?? "active"), raw }; }
  async submitShipment(accessToken: string, payload: any) { const raw = await requestJson(`${this.base()}/orders/${payload.externalOrderId ?? payload.orderId}/fulfillment`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type":"application/json" }, body: JSON.stringify(payload) }, this.timeout()); return { shipment: payload.shipment, externalFulfillmentId: String(raw.id ?? raw.fulfillment_id ?? payload.shipment?.id), marketplaceStatus: "accepted", raw, issues: [] } as any; }
  async updateShipmentTracking(accessToken: string, externalFulfillmentId: string, payload: unknown) { const raw = await requestJson(`${this.base()}/fulfillment/${externalFulfillmentId}/tracking`, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type":"application/json" }, body: JSON.stringify(payload) }, this.timeout()); return { shipment: (payload as any).shipment, marketplaceStatus: "accepted", raw } as any; }
  async cancelShipmentFulfillment(accessToken: string, externalFulfillmentId: string) { const raw = await requestJson(`${this.base()}/fulfillment/${externalFulfillmentId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { shipment: {} as any, marketplaceStatus: "cancelled", raw } as any; }
  async fetchShipmentStatus(accessToken: string, externalFulfillmentId: string) { const raw = await requestJson(`${this.base()}/fulfillment/${externalFulfillmentId}`, { headers: { Authorization: `Bearer ${accessToken}` } }, this.timeout()); return { shipment: {} as any, marketplaceStatus: String(raw.status ?? "submitted"), raw } as any; }
  normalizeShipmentError(error: unknown): MarketplaceApiError { return this.normalizeError(error); }
  normalizeInventoryError(error: unknown): MarketplaceApiError { return this.normalizeError(error); }
  normalizeError(error: unknown): MarketplaceApiError { const e = error as { status?: number; message?: string; name?: string }; const type = e.name === "AbortError" ? "Timeout" : e.status === 401 ? "Authentication" : e.status === 403 ? "Authorization" : e.status === 429 ? "RateLimit" : e.status && e.status >= 500 ? "Temporary" : e.status && e.status >= 400 ? "Permanent" : "Unknown"; return { type, code: e.status ? String(e.status) : undefined, message: type, retryable: ["RateLimit","Timeout","Temporary","Unknown"].includes(type) }; }
}
export class EbayAdapter extends HttpAdapter { constructor(env=process.env){ super(env,"EBAY"); } }
export class EtsyAdapter extends HttpAdapter { constructor(env=process.env){ super(env,"ETSY"); } }
export function getMarketplaceAdapter(channel: PublishChannel): MarketplaceAdapter { if (channel === PublishChannel.Ebay) return new EbayAdapter(); if (channel === PublishChannel.Etsy) return new EtsyAdapter(); throw new Error("Unsupported marketplace channel"); }

function normalizeOrder(raw: Record<string, unknown>, fallbackId: string): NormalizedMarketplaceOrder { const items = Array.isArray(raw.items) ? raw.items as Record<string, unknown>[] : []; return { externalOrderId: String(raw.id ?? raw.order_id ?? fallbackId), externalOrderNumber: raw.number ? String(raw.number) : undefined, status: String(raw.status ?? "paid"), currency: String(raw.currency ?? "EUR").toUpperCase(), subtotal: Number(raw.subtotal ?? raw.total ?? 0), shipping: Number(raw.shipping ?? 0), tax: Number(raw.tax ?? 0), total: Number(raw.total ?? raw.subtotal ?? 0), buyerEmail: raw.buyerEmail ? String(raw.buyerEmail) : undefined, buyerName: raw.buyerName ? String(raw.buyerName) : undefined, shippingAddress: raw.shippingAddress, billingAddress: raw.billingAddress, orderedAt: String(raw.orderedAt ?? new Date().toISOString()), items: items.map((i) => ({ externalOrderItemId: i.id ? String(i.id) : undefined, externalListingId: i.externalListingId ? String(i.externalListingId) : undefined, sku: i.sku ? String(i.sku) : undefined, title: String(i.title ?? "Marketplace item"), quantity: Number(i.quantity ?? 1), unitPrice: Number(i.unitPrice ?? i.price ?? 0), lineTotal: Number(i.lineTotal ?? i.total ?? i.unitPrice ?? i.price ?? 0) })), raw }; }
