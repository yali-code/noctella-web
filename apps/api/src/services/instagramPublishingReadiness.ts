import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { allowedHosts, assertVaultPolicy, validateInstagramMediaUrl } from "../config/instagramConfig";
import { resolvePublicApiOrigin } from "../config/publicApiOrigin";
import { apiVersion } from "../integrations/instagram/InstagramClient";
import { INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_CHANNEL, INSTAGRAM_VAULT_ACCOUNT_ID } from "../integrations/instagram/types";
import { assertCredentialEncryptionKey } from "./credentialEncryption";

export type ReadinessCheckState = "configured" | "default" | "missing" | "invalid";
export type InstagramConnectionReadiness = "connected" | "missing" | "disconnected" | "missing_credential" | "expired" | "wrong_account";

/**
 * Sanitized, local-only readiness: reuses the exact parsers publishing uses and reports
 * key names and states only. Never returns values and never contacts Instagram. Publishing
 * itself still fails closed on its own checks; this report is not an authorization.
 */
export async function getInstagramPublishingReadiness(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  const state = (key: string, validate: () => unknown, optional = false): ReadinessCheckState => {
    if (!env[key]?.trim()) return optional ? "default" : "missing";
    try { validate(); return "configured"; } catch { return "invalid"; }
  };
  const checks: Record<string, ReadinessCheckState> = {
    INSTAGRAM_API_VERSION: state("INSTAGRAM_API_VERSION", () => apiVersion(env)),
    INSTAGRAM_MEDIA_ALLOWED_HOSTS: state("INSTAGRAM_MEDIA_ALLOWED_HOSTS", () => { if (!allowedHosts(env).size) throw new Error(); }),
    PUBLIC_API_ORIGIN: state("PUBLIC_API_ORIGIN", () => resolvePublicApiOrigin(env)),
    INSTAGRAM_ALLOWED_ACCOUNT_IDS: state("INSTAGRAM_ALLOWED_ACCOUNT_IDS", () => assertVaultPolicy(env), true),
    // The encryption helper reads the process environment, exactly as credential loading does.
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY?.trim()
      ? (() => { try { assertCredentialEncryptionKey(); return "configured" as const; } catch { return "invalid" as const; } })()
      : "missing",
  };
  // Prepared media URLs are PUBLIC_API_ORIGIN + path, so that host must also be allowlisted.
  let mediaOriginAllowed = false;
  try { validateInstagramMediaUrl(`${resolvePublicApiOrigin(env)}/images/readiness.jpg`, env); mediaOriginAllowed = true; } catch { /* reported below */ }

  const driver = env.DATABASE_DRIVER ?? process.env.DATABASE_DRIVER ?? "sqlite";
  const { marketplaceConnections } = driver === "sqlite" || driver === "test-memory" ? sqlite : postgres;
  const [row] = await (db as any).select({ externalAccountId: marketplaceConnections.externalAccountId, status: marketplaceConnections.status,
    encryptedAccessToken: marketplaceConnections.encryptedAccessToken, tokenExpiresAt: marketplaceConnections.tokenExpiresAt })
    .from(marketplaceConnections)
    .where(and(eq(marketplaceConnections.channel, INSTAGRAM_CHANNEL), eq(marketplaceConnections.accountLabel, INSTAGRAM_ACCOUNT_LABEL))).limit(1);
  const expiresAt = row?.tokenExpiresAt instanceof Date ? row.tokenExpiresAt.getTime() : row?.tokenExpiresAt ? Date.parse(row.tokenExpiresAt) : null;
  const connection: InstagramConnectionReadiness = !row ? "missing"
    : row.externalAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID ? "wrong_account"
      : row.status !== "connected" ? "disconnected"
        : !row.encryptedAccessToken ? "missing_credential"
          : expiresAt !== null && expiresAt <= Date.now() ? "expired" : "connected";

  const missingConfiguration = Object.entries(checks).filter(([, value]) => value === "missing" || value === "invalid").map(([key]) => key);
  return {
    ready: missingConfiguration.length === 0 && mediaOriginAllowed && connection === "connected",
    checks, mediaOriginAllowed, connection, missingConfiguration,
  };
}
