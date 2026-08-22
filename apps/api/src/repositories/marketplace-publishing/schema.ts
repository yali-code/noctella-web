import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { getDatabaseConfig, type DatabaseDriver } from "../../db/config";
export function marketplacePublishingSchema(
  driver: DatabaseDriver = getDatabaseConfig().driver,
) {
  const schema = driver === "sqlite" ? sqlite : postgres;
  return {
    driver,
    marketplaceConnections: schema.marketplaceConnections,
    publishJobs: schema.publishJobs,
    publishAttempts: schema.publishAttempts,
    externalListings: schema.externalListings,
  };
}
export function decodePublishingJson<T>(value: unknown, fallback?: T): T {
  if (value == null) return fallback as T;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
export function encodePublishingJson(driver: DatabaseDriver, value: unknown) {
  if (driver === "sqlite")
    return typeof value === "string" ? value : JSON.stringify(value);
  return typeof value === "string" ? JSON.parse(value) : value;
}
export function publishingTimestampToIso(
  value: Date | string | null | undefined,
) {
  return value instanceof Date ? value.toISOString() : (value ?? undefined);
}
export function encodePublishingTimestamp(
  driver: DatabaseDriver,
  value: Date | string | null | undefined,
) {
  if (value == null) return value;
  if (driver === "sqlite")
    return value instanceof Date ? value.toISOString() : value;
  return value instanceof Date ? value : new Date(value);
}
export function encodePublishingValues(
  driver: DatabaseDriver,
  values: Record<string, unknown>,
) {
  const out = { ...values };
  for (const key of ["payloadSnapshot", "requestSnapshot", "responseSnapshot"])
    if (key in out && out[key] != null)
      out[key] = encodePublishingJson(driver, out[key]);
  for (const key of [
    "tokenExpiresAt",
    "createdAt",
    "updatedAt",
    "completedAt",
    "publishedAt",
  ])
    if (key in out)
      out[key] = encodePublishingTimestamp(
        driver,
        out[key] as Date | string | null | undefined,
      );
  return out;
}
