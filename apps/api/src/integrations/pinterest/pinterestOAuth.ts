/**
 * Analytics Stage 3: Pinterest OAuth 2.0 per Pinterest's documented flow - consent at
 * https://www.pinterest.com/oauth/, tokens from POST https://api.pinterest.com/v5/oauth/token
 * (application/x-www-form-urlencoded, Basic base64(client_id:client_secret)). A refresh returns a
 * new continuous refresh token. Secrets/tokens are server-side only and never placed in errors.
 */

/** Read-only scopes for organic Pin analytics (account, boards, pins). Single source of truth. */
export const PINTEREST_ANALYTICS_SCOPES: readonly string[] = Object.freeze(["user_accounts:read", "boards:read", "pins:read"]);
export const PINTEREST_CHANNEL = "pinterest";
export const PINTEREST_ACCOUNT_LABEL = "Default";

export type PinterestOAuthErrorKind = "not_configured" | "reconsent_required" | "authentication" | "rate_limit" | "temporary" | "malformed_response";

export class PinterestOAuthError extends Error {
  constructor(readonly kind: PinterestOAuthErrorKind, readonly providerError?: string) {
    super(`Pinterest OAuth ${kind}${providerError ? ` (${providerError})` : ""}`);
    this.name = "PinterestOAuthError";
  }
  get requiresReconsent() { return this.kind === "reconsent_required"; }
}

export interface PinterestOAuthConfig { clientId: string; clientSecret: string; redirectUri: string; apiBaseUrl: string }

export function resolvePinterestOAuthConfig(env: Record<string, string | undefined> = process.env): PinterestOAuthConfig | null {
  const clientId = env.PINTEREST_CLIENT_ID?.trim(), clientSecret = env.PINTEREST_CLIENT_SECRET?.trim(), redirectUri = env.PINTEREST_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, apiBaseUrl: "https://api.pinterest.com" };
}

function requireConfig(env: Record<string, string | undefined>): PinterestOAuthConfig {
  const config = resolvePinterestOAuthConfig(env);
  if (!config) throw new PinterestOAuthError("not_configured");
  return config;
}

export function buildPinterestAuthorizationUrl(env: Record<string, string | undefined>, state: string): string {
  const config = requireConfig(env);
  const url = new URL("https://www.pinterest.com/oauth/");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_ANALYTICS_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface PinterestTokens { accessToken: string; refreshToken?: string; expiresAt: string; scopes: string[] }

async function requestToken(env: Record<string, string | undefined>, form: Record<string, string>, fetchImpl: typeof fetch, now: Date, fallbackScopes: readonly string[]): Promise<PinterestTokens> {
  const config = requireConfig(env);
  let response: Response;
  try {
    response = await fetchImpl(`${config.apiBaseUrl}/v5/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new PinterestOAuthError("temporary");
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const providerError = typeof body?.error === "string" ? body.error.slice(0, 64) : undefined;
    if (providerError === "invalid_grant") throw new PinterestOAuthError("reconsent_required", providerError);
    if (response.status === 429) throw new PinterestOAuthError("rate_limit", providerError);
    if (response.status >= 500) throw new PinterestOAuthError("temporary", providerError);
    throw new PinterestOAuthError("authentication", providerError);
  }
  const accessToken = body?.access_token, expiresIn = body?.expires_in, refreshToken = body?.refresh_token, scope = body?.scope;
  if (typeof accessToken !== "string" || !accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || (refreshToken !== undefined && typeof refreshToken !== "string")) {
    throw new PinterestOAuthError("malformed_response");
  }
  const scopes = typeof scope === "string" && scope.trim() ? scope.split(/[\s,]+/).filter(Boolean) : [...fallbackScopes];
  return { accessToken, refreshToken: refreshToken || undefined, expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(), scopes };
}

export function exchangePinterestAuthorizationCode(env: Record<string, string | undefined>, code: string, fetchImpl: typeof fetch = fetch, now = new Date()) {
  const config = requireConfig(env);
  return requestToken(env, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, fetchImpl, now, PINTEREST_ANALYTICS_SCOPES);
}

export function refreshPinterestAccessToken(env: Record<string, string | undefined>, refreshToken: string, scopes: readonly string[], fetchImpl: typeof fetch = fetch, now = new Date()) {
  return requestToken(env, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, now, scopes);
}
