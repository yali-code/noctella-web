import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { DbClient } from "../db/client";
import { customerOAuthAttempts } from "../db/schema";
import { BadRequestError, UnauthorizedError } from "./errors";
import { linkVerifiedGoogleCustomer } from "./customerIdentity";

export interface GoogleIdentity { subject: string; email: string; emailVerified: boolean; name?: string; nonce: string }
export interface CustomerGoogleProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(code: string, codeVerifier: string): Promise<GoogleIdentity>;
}

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google Customer sign-in is not configured");
  const parsed = new URL(redirectUri);
  if ((process.env.NODE_ENV === "production" && parsed.protocol !== "https:") || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid Google redirect URI");
  return { clientId, clientSecret, redirectUri };
}

/** Library verifies signature, issuer, audience and expiry; nonce is checked against the attempt below. */
export function createGoogleProvider(): CustomerGoogleProvider {
  const settings = config();
  const client = new OAuth2Client(settings);
  return {
    authorizationUrl: ({ state, nonce, codeChallenge }) => client.generateAuthUrl({ response_type: "code", scope: ["openid", "email", "profile"], access_type: "online", state, nonce, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256, prompt: "select_account" }),
    exchange: async (code, codeVerifier) => {
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: settings.redirectUri });
      if (!tokens.id_token) throw new UnauthorizedError("Google identity verification failed");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: settings.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || !payload.nonce) throw new UnauthorizedError("Google identity verification failed");
      return { subject: payload.sub, email: payload.email, emailVerified: payload.email_verified === true, name: payload.name, nonce: payload.nonce };
    },
  };
}

const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const secret = () => crypto.randomBytes(32).toString("base64url");

export async function beginGoogleSignIn(db: DbClient, provider: CustomerGoogleProvider): Promise<{ url: string; state: string }> {
  const state = secret();
  const nonce = secret();
  const codeVerifier = secret();
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const createdAt = new Date().toISOString();
  await db.insert(customerOAuthAttempts).values({ id: crypto.randomUUID(), stateHash: digest(state), nonce, codeVerifier, createdAt, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), consumedAt: null });
  return { url: provider.authorizationUrl({ state, nonce, codeChallenge }), state };
}

export async function finishGoogleSignIn(db: DbClient, provider: CustomerGoogleProvider, state: string, code: string) {
  if (!state || state.length > 256 || !code || code.length > 4096) throw new BadRequestError("Invalid Google callback");
  const consumedAt = new Date().toISOString();
  const [attempt] = await db.select().from(customerOAuthAttempts).where(and(eq(customerOAuthAttempts.stateHash, digest(state)), isNull(customerOAuthAttempts.consumedAt), gt(customerOAuthAttempts.expiresAt, consumedAt))).limit(1);
  if (!attempt) throw new BadRequestError("Invalid or expired Google state");
  const claimed = await db.update(customerOAuthAttempts).set({ consumedAt, codeVerifier: "", nonce: "" }).where(and(eq(customerOAuthAttempts.id, attempt.id), isNull(customerOAuthAttempts.consumedAt), gt(customerOAuthAttempts.expiresAt, consumedAt))).returning({ id: customerOAuthAttempts.id });
  if (claimed.length !== 1) throw new BadRequestError("Invalid or expired Google state");
  const identity = await provider.exchange(code, attempt.codeVerifier);
  if (identity.nonce !== attempt.nonce) throw new UnauthorizedError("Google identity verification failed");
  return linkVerifiedGoogleCustomer(db, identity);
}
