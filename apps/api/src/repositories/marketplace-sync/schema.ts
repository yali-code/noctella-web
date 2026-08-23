import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { getDatabaseConfig, type DatabaseDriver } from "../../db/config";

export function marketplaceSyncSchema(
  driver: DatabaseDriver = getDatabaseConfig().driver,
) {
  const schema = driver === "sqlite" ? sqlite : postgres;
  return {
    driver,
    marketplaceConnections: schema.marketplaceConnections,
    externalListings: schema.externalListings,
    marketplaceWebhookEvents: schema.marketplaceWebhookEvents,
    marketplaceOrders: schema.marketplaceOrders,
    marketplaceOrderItems: schema.marketplaceOrderItems,
    marketplaceSyncRuns: schema.marketplaceSyncRuns,
    marketplaceImportAttempts: schema.marketplaceImportAttempts,
    products: schema.products,
  };
}

export function encodeMarketplaceJson(driver: DatabaseDriver, value: unknown) {
  if (driver === "sqlite") return JSON.stringify(value);
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function decodeMarketplaceJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function encodeMarketplaceTimestamp(
  driver: DatabaseDriver,
  value: Date | string | null | undefined,
) {
  if (value == null) return value;
  if (driver === "sqlite") return value instanceof Date ? value.toISOString() : value;
  return value instanceof Date ? value : new Date(value);
}

export function marketplaceTimestampToIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}

export function encodeMarketplaceValues(
  driver: DatabaseDriver,
  values: Record<string, unknown>,
) {
  const out = { ...values };
  for (const key of ["shippingAddressSnapshot", "billingAddressSnapshot", "rawPayloadSnapshot", "payloadSnapshot"])
    if (key in out && out[key] != null) out[key] = encodeMarketplaceJson(driver, out[key]);
  for (const key of ["tokenExpiresAt", "receivedAt", "processedAt", "orderedAt", "importedAt", "startedAt", "completedAt", "publishedAt", "createdAt", "updatedAt"])
    if (key in out) out[key] = encodeMarketplaceTimestamp(driver, out[key] as Date | string | null | undefined);
  if (driver !== "sqlite")
    for (const key of ["signatureValid", "retryable"])
      if (key in out && out[key] != null) out[key] = out[key] ? 1 : 0;
  return out;
}

export function normalizeMarketplaceRow<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row };
  for (const key of ["tokenExpiresAt", "receivedAt", "processedAt", "orderedAt", "importedAt", "startedAt", "completedAt", "publishedAt", "createdAt", "updatedAt"])
    if (key in out && out[key] != null) out[key] = marketplaceTimestampToIso(out[key]);
  for (const key of ["subtotal", "shipping", "tax", "total", "unitPrice", "lineTotal", "priceEur", "priceUsd", "wooListingPriceEur", "ebayListingPriceEur", "etsyListingPriceEur"])
    if (key in out && out[key] != null) out[key] = Number(out[key]);
  for (const key of ["signatureValid", "retryable"])
    if (key in out && out[key] != null) out[key] = Boolean(out[key]);
  return out as T;
}
