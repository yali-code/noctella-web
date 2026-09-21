import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { marketplaceConnections } from "../../db/schema";
import { assertVaultPolicy } from "../../config/instagramConfig";
import { decryptCredential, encryptCredential } from "../../services/credentialEncryption";
import { InstagramClient } from "./InstagramClient";
import { InstagramClientError, INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_CHANNEL, INSTAGRAM_SCOPES, INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "./types";

export function safeInstagramConnection(row: typeof marketplaceConnections.$inferSelect) {
  return {
    id: row.id, channel: row.channel, accountLabel: row.accountLabel,
    externalAccountId: row.externalAccountId, status: row.status,
    scopes: JSON.parse(row.scopes ?? "[]") as string[],
    tokenExpiresAt: row.tokenExpiresAt, updatedAt: row.updatedAt,
  };
}

export async function getInstagramConnection(db: DbClient, accountLabel = INSTAGRAM_ACCOUNT_LABEL) {
  if (accountLabel !== INSTAGRAM_ACCOUNT_LABEL) throw new InstagramClientError("authorization", false);
  const [row] = await db.select().from(marketplaceConnections).where(and(eq(marketplaceConnections.channel, INSTAGRAM_CHANNEL), eq(marketplaceConnections.accountLabel, accountLabel))).limit(1);
  if (row && row.externalAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID) throw new InstagramClientError("authorization", false);
  return row ? safeInstagramConnection(row) : null;
}

export async function loadInstagramCredential(db: DbClient, accountLabel = INSTAGRAM_ACCOUNT_LABEL) {
  if (accountLabel !== INSTAGRAM_ACCOUNT_LABEL) throw new InstagramClientError("authorization", false);
  const [row] = await db.select().from(marketplaceConnections).where(and(eq(marketplaceConnections.channel, INSTAGRAM_CHANNEL), eq(marketplaceConnections.accountLabel, accountLabel))).limit(1);
  if (!row || row.externalAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID || row.status !== "connected" || !row.encryptedAccessToken) throw new InstagramClientError("configuration", false);
  if (row.tokenExpiresAt && Date.parse(row.tokenExpiresAt) <= Date.now()) throw new InstagramClientError("authentication", false);
  return { row, accessToken: decryptCredential(row.encryptedAccessToken) };
}

export async function upsertInstagramConnection(db: DbClient, input: { accessToken: string; accountLabel?: string; scopes: string[]; tokenExpiresAt?: string | null }, transport?: InstagramTransport, env: NodeJS.ProcessEnv = process.env) {
  assertVaultPolicy(env);
  const accountLabel = input.accountLabel ?? INSTAGRAM_ACCOUNT_LABEL;
  if (accountLabel !== INSTAGRAM_ACCOUNT_LABEL || typeof input.accessToken !== "string" || !input.accessToken ||
      input.accessToken.length > 8192 || input.accessToken !== input.accessToken.trim() ||
      input.scopes.length !== INSTAGRAM_SCOPES.length || !INSTAGRAM_SCOPES.every((scope) => input.scopes.includes(scope))) throw new InstagramClientError("configuration", false);
  if (input.tokenExpiresAt && (!Number.isFinite(Date.parse(input.tokenExpiresAt)) || Date.parse(input.tokenExpiresAt) <= Date.now())) throw new InstagramClientError("configuration", false);
  const client = new InstagramClient(input.accessToken, transport, env);
  const account = await client.verifyAccount();
  if (account.id !== INSTAGRAM_VAULT_ACCOUNT_ID) throw new InstagramClientError("authorization", false);
  const updatedAt = new Date().toISOString();
  const values = {
    externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID,
    encryptedAccessToken: encryptCredential(input.accessToken),
    encryptedRefreshToken: null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    scopes: JSON.stringify(input.scopes),
    status: "connected",
    lastError: null,
    updatedAt,
  };
  await db.insert(marketplaceConnections).values({ id: `conn_${randomUUID()}`, channel: INSTAGRAM_CHANNEL, accountLabel, ...values, createdAt: updatedAt })
    .onConflictDoUpdate({ target: [marketplaceConnections.channel, marketplaceConnections.accountLabel], set: values }).run();
  return (await getInstagramConnection(db, accountLabel))!;
}

export async function verifyInstagramConnection(db: DbClient, transport?: InstagramTransport, env: NodeJS.ProcessEnv = process.env) {
  assertVaultPolicy(env);
  const { row, accessToken } = await loadInstagramCredential(db);
  await new InstagramClient(accessToken, transport, env).verifyAccount();
  return safeInstagramConnection(row);
}
