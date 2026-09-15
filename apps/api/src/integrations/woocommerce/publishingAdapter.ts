import type { MarketplaceApiError } from "@noctella/shared";
import type { AdapterListingResult, MarketplacePublishPayload } from "../../services/marketplaceAdapters";
import { WooCommerceClient, WooCommerceClientError, type WooCommerceTransport } from "./connectionClient";
import type { WooCommerceProductDraft } from "./productAdapter";

export interface WooCommercePublishAdapter {
  createListing(accessToken: string, payload: MarketplacePublishPayload): Promise<AdapterListingResult>;
  updateListing(accessToken: string, externalListingId: string, payload: MarketplacePublishPayload): Promise<AdapterListingResult>;
  normalizeError(error: unknown): MarketplaceApiError;
}

export class CanonicalWooCommercePublishAdapter implements WooCommercePublishAdapter {
  private readonly client: WooCommerceClient;
  constructor(config: { storeUrl: string; consumerKey: string; consumerSecret: string }, transport: WooCommerceTransport) {
    this.client = new WooCommerceClient(config, transport);
  }
  createListing(_accessToken: string, payload: MarketplacePublishPayload) { return this.client.createProduct(payload as WooCommerceProductDraft); }
  updateListing(_accessToken: string, externalListingId: string, payload: MarketplacePublishPayload) { return this.client.updateProduct(externalListingId, payload as WooCommerceProductDraft); }
  normalizeError(error: unknown): MarketplaceApiError {
    const kind = error instanceof WooCommerceClientError ? error.kind : "provider";
    const type = kind === "authentication" ? "Authentication" : kind === "authorization" ? "Authorization" : kind === "rate_limit" ? "RateLimit" : kind === "timeout" ? "Timeout" : kind === "remote_validation" || kind === "not_found" || kind === "configuration" || kind === "malformed_response" ? "Permanent" : "Temporary";
    return { type, code: kind, message: error instanceof WooCommerceClientError ? error.message : "WooCommerce Product request failed", retryable: ["RateLimit", "Timeout", "Temporary"].includes(type) };
  }
}
