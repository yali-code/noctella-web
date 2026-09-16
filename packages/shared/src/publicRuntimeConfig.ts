const LOCAL_API_BASE_URL = "http://localhost:4000";

export class PublicRuntimeConfigurationError extends Error {
  constructor(variable: string, reason: string) {
    super(`Invalid public runtime configuration: ${variable} ${reason}`);
    this.name = "PublicRuntimeConfigurationError";
  }
}

/**
 * Resolves the browser-visible API origin shared by Admin and Storefront. Development and test
 * retain the established localhost default; production fails closed so a missing or unsafe value
 * cannot be compiled into a deployable client bundle.
 */
export function resolvePublicApiBaseUrl(value: string | undefined, nodeEnv: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    if (nodeEnv === "production") throw new PublicRuntimeConfigurationError("NEXT_PUBLIC_API_BASE_URL", "is required in production");
    return LOCAL_API_BASE_URL;
  }

  let parsed: URL;
  try { parsed = new URL(configured); }
  catch { throw new PublicRuntimeConfigurationError("NEXT_PUBLIC_API_BASE_URL", "must be a valid absolute HTTP(S) origin"); }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new PublicRuntimeConfigurationError("NEXT_PUBLIC_API_BASE_URL", "must be a valid absolute HTTP(S) origin");
  }
  if (nodeEnv === "production" && (parsed.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
    throw new PublicRuntimeConfigurationError("NEXT_PUBLIC_API_BASE_URL", "must be a non-local HTTPS origin in production");
  }
  return parsed.origin;
}
