import type { MarketplaceTokens } from "../../services/marketplaceAdapters";

/**
 * Stage 3B: real eBay OAuth 2.0 (authorization-code grant + refresh) per eBay's documented
 * semantics - consent at auth.ebay.com/oauth2/authorize, tokens from
 * POST {api}/identity/v1/oauth2/token with application/x-www-form-urlencoded and
 * Authorization: Basic base64(client_id:client_secret). Client secret and tokens are server-side
 * only: never logged, never placed in error messages, never returned to callers beyond the
 * MarketplaceTokens the encrypted connection storage persists.
 */

/** The single source of truth for the eBay consent scope list. */
export const EBAY_ANALYTICS_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly";
export const EBAY_OAUTH_SCOPES: readonly string[] = Object.freeze([EBAY_ANALYTICS_SCOPE]);

export type EbayOAuthErrorKind = "not_configured" | "reconsent_required" | "authentication" | "rate_limit" | "temporary" | "malformed_response";

/** Safe-by-construction error: carries only a kind and eBay's own short error code. */
export class EbayOAuthError extends Error {
  constructor(readonly kind: EbayOAuthErrorKind, readonly providerError?: string) {
    super(`eBay OAuth ${kind}${providerError ? ` (${providerError})` : ""}`);
    this.name = "EbayOAuthError";
  }
  get requiresReconsent() { return this.kind === "reconsent_required"; }
}

export interface EbayOAuthConfig { clientId: string; clientSecret: string; ruName: string; authBaseUrl: string; apiBaseUrl: string }

/** Existing env names (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REDIRECT_URI = RuName, EBAY_API_BASE_URL); EBAY_AUTH_BASE_URL only for sandbox. */
export function resolveEbayOAuthConfig(env: Record<string, string | undefined> = process.env): EbayOAuthConfig | null {
  const clientId = env.EBAY_CLIENT_ID?.trim(), clientSecret = env.EBAY_CLIENT_SECRET?.trim(), ruName = env.EBAY_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !ruName) return null;
  return { clientId, clientSecret, ruName, authBaseUrl: env.EBAY_AUTH_BASE_URL?.trim() || "https://auth.ebay.com", apiBaseUrl: env.EBAY_API_BASE_URL?.trim() || "https://api.ebay.com" };
}

function requireConfig(env: Record<string, string | undefined>): EbayOAuthConfig {
  const config = resolveEbayOAuthConfig(env);
  if (!config) throw new EbayOAuthError("not_configured");
  return config;
}

export function buildEbayAuthorizationUrl(env: Record<string, string | undefined>, state: string): string {
  const config = requireConfig(env);
  const url = new URL("/oauth2/authorize", config.authBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", EBAY_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestToken(env: Record<string, string | undefined>, form: Record<string, string>, fetchImpl: typeof fetch, now: Date): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  const config = requireConfig(env);
  let response: Response;
  try {
    response = await fetchImpl(new URL("/identity/v1/oauth2/token", config.apiBaseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new EbayOAuthError("temporary");
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    // Only eBay's short error code (e.g. "invalid_grant") is kept - never the full body.
    const providerError = typeof body?.error === "string" ? body.error.slice(0, 64) : undefined;
    if (providerError === "invalid_grant") throw new EbayOAuthError("reconsent_required", providerError);
    if (response.status === 401 || providerError === "invalid_client") throw new EbayOAuthError("authentication", providerError);
    if (response.status === 429) throw new EbayOAuthError("rate_limit", providerError);
    if (response.status >= 500) throw new EbayOAuthError("temporary", providerError);
    throw new EbayOAuthError("authentication", providerError);
  }
  const accessToken = body?.access_token, expiresIn = body?.expires_in, refreshToken = body?.refresh_token;
  if (typeof accessToken !== "string" || !accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || (refreshToken !== undefined && typeof refreshToken !== "string")) {
    throw new EbayOAuthError("malformed_response");
  }
  return { accessToken, refreshToken: refreshToken || undefined, expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() };
}

/** Authorization-code grant. eBay's code response does not echo scopes; the granted set is the consented request set. */
export async function exchangeEbayAuthorizationCode(env: Record<string, string | undefined>, code: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<MarketplaceTokens> {
  const config = requireConfig(env);
  const tokens = await requestToken(env, { grant_type: "authorization_code", code, redirect_uri: config.ruName }, fetchImpl, now);
  return { ...tokens, scopes: [...EBAY_OAUTH_SCOPES] };
}

/**
 * Refresh grant. `scopes` must be the stored consented set (equal to or a subset of the original
 * consent). The response normally carries no refresh_token, so refreshToken is left undefined and
 * the caller keeps the existing one (refreshConnection already does).
 */
export async function refreshEbayAccessToken(env: Record<string, string | undefined>, refreshToken: string, scopes: readonly string[], fetchImpl: typeof fetch = fetch, now = new Date()): Promise<MarketplaceTokens> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  if (scopes.length > 0) form.scope = scopes.join(" ");
  const tokens = await requestToken(env, form, fetchImpl, now);
  return { ...tokens, scopes: scopes.length > 0 ? [...scopes] : undefined };
}
