/**
 * Sprint 64B: minimal, dependency-free cookie parsing/serialization. No
 * cookie-parser/express-session dependency is added - this codebase already
 * prefers built-in primitives for security-adjacent code (see
 * services/credentialEncryption.ts).
 */
export const SESSION_COOKIE_NAME = "noctella_admin_session";

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) { try { out[key] = decodeURIComponent(value); } catch { out[key] = value; } }
  }
  return out;
}

function baseAttributes(): string[] {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  if (process.env.COOKIE_DOMAIN) parts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
  return parts;
}

/** Max-Age is the primary expiry mechanism (Expires kept as a compatible fallback). */
export function serializeSessionCookie(rawToken: string, expiresAt: Date): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [`${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`, ...baseAttributes(), `Max-Age=${maxAgeSeconds}`, `Expires=${expiresAt.toUTCString()}`].join("; ");
}

/** Clears the cookie with attributes matching serializeSessionCookie, so the browser actually removes it. */
export function serializeClearCookie(): string {
  return [`${SESSION_COOKIE_NAME}=`, ...baseAttributes(), "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"].join("; ");
}
