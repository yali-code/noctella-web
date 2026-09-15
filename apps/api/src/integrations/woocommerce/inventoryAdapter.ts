import type { MarketplaceApiError, MarketplaceStockUpdateResult } from "@noctella/shared";
import type { MarketplaceInventoryResult } from "../../services/marketplaceAdapters";
import { WooCommerceClient, WooCommerceClientError, type WooCommerceTransport } from "./connectionClient";

export interface WooCommerceInventoryAdapter {
  getListingInventory(accessToken: string, externalListingId: string): Promise<MarketplaceInventoryResult>;
  updateListingInventory(accessToken: string, externalListingId: string, stock: number): Promise<MarketplaceStockUpdateResult>;
  normalizeInventoryError(error: unknown): MarketplaceApiError;
}

export class CanonicalWooCommerceInventoryAdapter implements WooCommerceInventoryAdapter {
  private readonly client: WooCommerceClient;
  constructor(config: { storeUrl: string; consumerKey: string; consumerSecret: string }, transport: WooCommerceTransport) {
    this.client = new WooCommerceClient(config, transport);
  }
  getListingInventory(_accessToken: string, externalListingId: string) { return this.client.getProductInventory(externalListingId); }
  async updateListingInventory(_accessToken: string, externalListingId: string, stock: number) {
    const result = await this.client.updateProductInventory(externalListingId, stock);
    return { ...result, status: result.confirmedStock === stock ? "updated" : "conflict" };
  }
  normalizeInventoryError(error: unknown): MarketplaceApiError {
    const kind = error instanceof WooCommerceClientError ? error.kind : "provider";
    const type = kind === "authentication" ? "Authentication" : kind === "authorization" ? "Authorization" : kind === "rate_limit" ? "RateLimit" : kind === "timeout" ? "Timeout" : kind === "provider" ? "Temporary" : "Permanent";
    return { type, code: kind, message: error instanceof WooCommerceClientError ? error.message : "WooCommerce inventory request failed", retryable: ["RateLimit", "Timeout", "Temporary"].includes(type) };
  }
}
