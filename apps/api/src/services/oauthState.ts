import crypto from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function stateSecret(): Buffer {
  const raw = process.env.MARKETPLACE_OAUTH_STATE_SECRET ?? process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("MARKETPLACE_OAUTH_STATE_SECRET or MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY is required");
  return Buffer.from(raw);
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function createOAuthState(channel: string, accountLabel: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = { channel, accountLabel, nonce: crypto.randomBytes(24).toString("base64url"), exp: Date.now() + ttlMs };
  const encoded = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(state: string, channel: string): { accountLabel: string } {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new Error("OAuth state mismatch");
  const expected = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("OAuth state mismatch");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { channel: string; accountLabel: string; exp: number };
  if (payload.channel !== channel) throw new Error("OAuth state mismatch");
  if (payload.exp < Date.now()) throw new Error("OAuth state expired");
  return { accountLabel: payload.accountLabel };
}
