import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { instagramPublishAttempts } from "../db/schema";
import { assertVaultPolicy, validateInstagramMediaUrl } from "../config/instagramConfig";
import { InstagramClient } from "../integrations/instagram/InstagramClient";
import { loadInstagramCredential } from "../integrations/instagram/connection";
import { InstagramPublishingAdapter } from "../integrations/instagram/publishingAdapter";
import { InstagramClientError, INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../integrations/instagram/types";

function publicAttempt(row: typeof instagramPublishAttempts.$inferSelect) {
  return {
    id: row.id, connectionId: row.connectionId, status: row.status,
    containerId: row.containerId, publishedMediaId: row.publishedMediaId,
    lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt, publishedAt: row.publishedAt,
  };
}

async function attemptByKey(db: DbClient, idempotencyKey: string) {
  const [row] = await db.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.idempotencyKey, idempotencyKey)).limit(1);
  return row;
}

function safeKind(error: unknown): string {
  return error instanceof InstagramClientError ? error.kind : "unknown";
}

export async function getInstagramPublishAttempt(db: DbClient, id: string) {
  const [row] = await db.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.id, id)).limit(1);
  return row ? publicAttempt(row) : null;
}

/** No network call in tests unless an injected transport explicitly simulates it. */
export async function publishInstagramImage(
  db: DbClient,
  input: { accountLabel?: string; imageUrl: string; caption: string; idempotencyKey: string },
  transport?: InstagramTransport,
  env: NodeJS.ProcessEnv = process.env,
  pause?: (ms: number) => Promise<void>,
) {
  assertVaultPolicy(env);
  if ((input.accountLabel ?? INSTAGRAM_ACCOUNT_LABEL) !== INSTAGRAM_ACCOUNT_LABEL ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey) ||
      typeof input.caption !== "string" || input.caption.length > 2200) throw new InstagramClientError("configuration", false);
  const mediaUrl = validateInstagramMediaUrl(input.imageUrl, env);
  const { row: connection, accessToken } = await loadInstagramCredential(db, input.accountLabel);
  const existing = await attemptByKey(db, input.idempotencyKey);
  if (existing) {
    if (existing.connectionId !== connection.id || existing.caption !== input.caption || existing.mediaUrl !== mediaUrl) throw new InstagramClientError("configuration", false);
    if (!existing.containerId || !["container_created", "processing", "ready"].includes(existing.status)) return publicAttempt(existing);
  }
  const client = new InstagramClient(accessToken, transport, env);
  await client.verifyAccount();
  const now = new Date().toISOString();
  const id = existing?.id ?? `igp_${randomUUID()}`;
  if (!existing) {
    try {
      db.insert(instagramPublishAttempts).values({ id, connectionId: connection.id, idempotencyKey: input.idempotencyKey, caption: input.caption, mediaUrl, status: "pending", createdAt: now, updatedAt: now }).run();
    } catch {
      const winner = await attemptByKey(db, input.idempotencyKey);
      if (!winner || winner.connectionId !== connection.id || winner.caption !== input.caption || winner.mediaUrl !== mediaUrl) throw new InstagramClientError("configuration", false);
      return publicAttempt(winner);
    }
  }

  const transition = (from: string, values: Partial<typeof instagramPublishAttempts.$inferInsert>) =>
    db.update(instagramPublishAttempts).set({ ...values, updatedAt: new Date().toISOString() })
      .where(and(eq(instagramPublishAttempts.id, id), eq(instagramPublishAttempts.status, from)))
      .returning({ id: instagramPublishAttempts.id }).all().length === 1;
  const result = async () => (await getInstagramPublishAttempt(db, id))!;
  const adapter = new InstagramPublishingAdapter(client, pause);
  let containerId = existing?.containerId;
  if (!containerId) {
    try {
      containerId = await adapter.createImageContainer(INSTAGRAM_VAULT_ACCOUNT_ID, mediaUrl, input.caption);
      if (!transition("pending", { containerId, status: "container_created" })) return result();
    } catch (error) {
      transition("pending", { status: "failed", lastError: safeKind(error) });
      return result();
    }
  }

  if (existing?.status !== "ready") {
    transition("container_created", { status: "processing" });
    try {
      const ready = await adapter.waitForReady(containerId);
      if (!ready) return result();
      transition("processing", { status: "ready", lastError: null });
    } catch (error) {
      if (error instanceof InstagramClientError && error.kind === "invalid_media") transition("processing", { status: "failed", lastError: safeKind(error) });
      else transition("processing", { lastError: safeKind(error) });
      return result();
    }
  }

  // This is the sole publish claim. Concurrent pollers may check readiness, but only one
  // can cross ready -> publishing; a crashed/unknown publish is never automatically retried.
  if (!transition("ready", { status: "publishing" })) return result();
  try {
    const publishedMediaId = await adapter.publishContainer(INSTAGRAM_VAULT_ACCOUNT_ID, containerId);
    transition("publishing", { status: "published", publishedMediaId, publishedAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    transition("publishing", { status: "reconciliation_required", lastError: safeKind(error) });
  }
  return result();
}
