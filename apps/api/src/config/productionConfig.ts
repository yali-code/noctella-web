import path from "node:path";
import { parseConfiguredOrigins } from "../auth/originAllowlist";

const PRODUCTION_PERSISTENT_MOUNT = "/var/data";

export class ProductionConfigurationError extends Error {
  constructor(variable: string, reason: string) {
    super(`Invalid production configuration: ${variable} ${reason}`);
    this.name = "ProductionConfigurationError";
  }
}

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable]?.trim();
  if (!value) throw new ProductionConfigurationError(variable, "is required");
  return value;
}

function productionOrigin(value: string, variable: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ProductionConfigurationError(variable, "must be a valid HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ProductionConfigurationError(variable, "must be a valid HTTPS origin");
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1") {
    throw new ProductionConfigurationError(variable, "must not use localhost");
  }
  return parsed;
}

function pathInsidePersistentMount(value: string, variable: string, allowMountRoot: boolean): string {
  if (!path.isAbsolute(value)) {
    throw new ProductionConfigurationError(variable, "must be an absolute path inside the persistent mount");
  }
  const mount = path.resolve(PRODUCTION_PERSISTENT_MOUNT);
  const resolved = path.resolve(value);
  const relative = path.relative(mount, resolved);
  const inside = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!inside || (!allowMountRoot && relative === "")) {
    throw new ProductionConfigurationError(variable, "must resolve inside the persistent mount");
  }
  return resolved;
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hostnameUsesCookieDomain(hostname: string, cookieDomain: string): boolean {
  const host = hostname.toLowerCase();
  const domain = cookieDomain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export function validateProductionApiConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (env.DATABASE_DRIVER !== "sqlite") throw new ProductionConfigurationError("DATABASE_DRIVER", "must be sqlite");

  const databaseUrl = required(env, "DATABASE_URL");
  if (databaseUrl === ":memory:") throw new ProductionConfigurationError("DATABASE_URL", "must be a persistent SQLite file path");
  const databasePath = pathInsidePersistentMount(databaseUrl, "DATABASE_URL", false);
  const photoDir = required(env, "PRODUCT_PHOTO_DIR");
  const photoRoot = pathInsidePersistentMount(photoDir, "PRODUCT_PHOTO_DIR", false);
  if (pathContains(photoRoot, databasePath)) {
    throw new ProductionConfigurationError("PRODUCT_PHOTO_DIR", "must not contain DATABASE_URL");
  }

  const configuredOrigins: URL[] = [];
  for (const variable of ["ADMIN_APP_ORIGIN", "STOREFRONT_APP_ORIGIN"] as const) {
    const origins = parseConfiguredOrigins(required(env, variable));
    if (origins.length === 0) throw new ProductionConfigurationError(variable, "must contain an HTTPS origin");
    for (const origin of origins) configuredOrigins.push(productionOrigin(origin, variable));
  }

  const cookieDomain = required(env, "COOKIE_DOMAIN");
  const normalizedCookieDomain = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(normalizedCookieDomain) || /localhost/i.test(cookieDomain)) {
    throw new ProductionConfigurationError("COOKIE_DOMAIN", "must be a production domain name");
  }
  if (!configuredOrigins.every((origin) => hostnameUsesCookieDomain(origin.hostname, normalizedCookieDomain))) {
    throw new ProductionConfigurationError("COOKIE_DOMAIN", "must match the configured application origins");
  }
  required(env, "SCHEDULER_AUTH_TOKEN");
  required(env, "ERP_INTEGRATION_KEY");
  if (env.MOCK_PAYMENTS_ENABLED !== "false") throw new ProductionConfigurationError("MOCK_PAYMENTS_ENABLED", "must be false");
  if (env.STRIPE_PUBLIC_CHECKOUT_ENABLED === "true") throw new ProductionConfigurationError("STRIPE_PUBLIC_CHECKOUT_ENABLED", "must be disabled");
}
