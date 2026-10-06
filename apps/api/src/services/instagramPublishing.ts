import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AdminRole } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { hasPermission } from "../auth/permissions";
import { socialId } from "../validation/socialContent";
import { resolvePublicApiOrigin } from "../config/publicApiOrigin";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialContentApprovalRepository } from "../repositories/social-content/approvals";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { assertVaultPolicy, validateInstagramMediaUrl } from "../config/instagramConfig";
import { InstagramClient } from "../integrations/instagram/InstagramClient";
import { loadInstagramCredential } from "../integrations/instagram/connection";
import { InstagramPublishingAdapter } from "../integrations/instagram/publishingAdapter";
import { InstagramClientError, INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../integrations/instagram/types";

type Attempt = typeof sqlite.instagramPublishAttempts.$inferSelect | typeof postgres.instagramPublishAttempts.$inferSelect;
export const instagramPublishSchema = z.object({
  approvalId: socialId,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
}).strict();

function publicAttempt(row: Attempt) {
  return {
    id: row.id, connectionId: row.connectionId, status: row.status,
    containerId: row.containerId, publishedMediaId: row.publishedMediaId,
    lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt, publishedAt: row.publishedAt,
  };
}

function safeKind(error: unknown): string {
  return error instanceof InstagramClientError ? error.kind : "unknown";
}

export async function getInstagramPublishAttempt(db: DbClient, id: string) {
  const { instagramPublishAttempts } = process.env.DATABASE_DRIVER === "postgres" ? postgres : sqlite;
  const [row] = await db.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.id, id)).limit(1);
  return row ? publicAttempt(row) : null;
}

/** No network call in tests unless an injected transport explicitly simulates it. */
export async function publishInstagramImage(
  db: DbClient,
  value: unknown,
  actorId: string,
  transport?: InstagramTransport,
  env: NodeJS.ProcessEnv = process.env,
  pause?: (ms: number) => Promise<void>,
) {
  const input = instagramPublishSchema.parse(value);
  socialId.parse(actorId);
  assertVaultPolicy(env);
  const driver = env.DATABASE_DRIVER ?? process.env.DATABASE_DRIVER ?? "sqlite";
  const sync = driver === "sqlite" || driver === "test-memory";
  const { instagramPublishAttempts, socialContents, adminUsers, marketplaceConnections } = sync ? sqlite : postgres;
  const { transaction } = createSocialContentRepository(db, driver);
  const approvals = createSocialContentApprovalRepository(db, driver);
  const prepared = createPreparedImageRepository(db, driver);
  const now = () => sync ? new Date().toISOString() : new Date();
  function* authorizeActor(tx: any): Generator<any, void, any> {
    const [actor] = yield tx.select().from(adminUsers).where(eq(adminUsers.id, actorId));
    if (!actor || actor.status !== "active" || !hasPermission(actor.role as AdminRole, "products.publish")) {
      throw new InstagramClientError("authorization", false);
    }
  }
  function* resolveAttempt(tx: any): Generator<any, Attempt | undefined, any> {
    const [existing] = yield tx.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.idempotencyKey, input.idempotencyKey));
    if (existing) {
      if (existing.approvalId !== input.approvalId) throw new ConflictError("Publishing key is bound to different or historical approval");
      return existing;
    }
    const [consumed] = yield tx.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.approvalId, input.approvalId));
    if (consumed) throw new ConflictError("Approval already has a publishing attempt");
  }
  const existing = await transaction(function* (tx) { yield* authorizeActor(tx); return yield* resolveAttempt(tx); });
  const resumable = (row: Attempt) => !!row.containerId && ["container_created", "processing", "ready"].includes(row.status);
  const unstarted = (row: Attempt) => row.status === "pending" && row.providerEntryState === "unclaimed" && !row.containerId;
  if (existing && !resumable(existing) && !unstarted(existing)) return publicAttempt(existing);

  function* snapshot(tx: any) {
    const approval = yield* approvals.find(tx, input.approvalId);
    if (!approval) throw new NotFoundError("Human Approval not found");
    let query = tx.select().from(socialContents).where(eq(socialContents.id, approval.contentId));
    if (!sync) query = query.for("update");
    const [content] = yield query;
    if (!content) throw new NotFoundError("Social content not found");
    if (content.status !== "approved" || content.version !== approval.contentVersion + 1) throw new ConflictError("Approved content changed");
    if (content.platform !== "instagram" || content.accountLabel !== INSTAGRAM_ACCOUNT_LABEL) throw new BadRequestError("Unsupported publishing target");
    if (typeof content.caption !== "string" || !content.caption.trim() || content.caption.length > 2200) throw new BadRequestError("Invalid approved caption");
    const image = yield* prepared.find(tx, approval.contentId, approval.preparedImageId);
    const source = yield* prepared.source(tx, approval.contentId, image.sourcePhotoId);
    return { approval, content, image, source };
  }
  const before = await transaction(snapshot);
  await createSocialContentPreparationService(db, driver).validatePreparedImageCurrent(before.approval.contentId, before.image.id);
  const mediaUrl = validateInstagramMediaUrl(resolvePublicApiOrigin(env) + before.image.outputPath, env);
  // Local credential resolution makes no provider request.
  const { row: connection, accessToken } = await loadInstagramCredential(db);
  let authorized: { row: Attempt; created: boolean };
  try {
    authorized = await transaction(function* (tx) {
      yield* authorizeActor(tx);
      const current = yield* snapshot(tx);
      if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Approved media changed before publishing authorization");
      let connectionQuery = tx.select().from(marketplaceConnections).where(eq(marketplaceConnections.id, connection.id));
      if (!sync) connectionQuery = connectionQuery.for("share");
      const [liveConnection] = yield connectionQuery;
      if (!liveConnection || liveConnection.status !== "connected" || liveConnection.channel !== "instagram" ||
          liveConnection.accountLabel !== INSTAGRAM_ACCOUNT_LABEL || liveConnection.externalAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID ||
          liveConnection.encryptedAccessToken !== connection.encryptedAccessToken) throw new ConflictError("Instagram connection changed");
      const row = yield* resolveAttempt(tx);
      if (row) {
        if (row.connectionId !== connection.id || row.caption !== current.content.caption || row.mediaUrl !== mediaUrl) throw new ConflictError("Publishing snapshot changed");
        return { row, created: false };
      }
      const [inserted] = yield tx.insert(instagramPublishAttempts).values({
        id: `igp_${randomUUID()}`, approvalId: input.approvalId, connectionId: connection.id,
        idempotencyKey: input.idempotencyKey, caption: current.content.caption, mediaUrl,
        status: "pending", providerEntryState: "unclaimed", createdAt: now(), updatedAt: now(),
      }).returning();
      return { row: inserted as Attempt, created: true };
    });
  } catch (error) {
    // A uniqueness race must be resolved after PostgreSQL rolls back the failed transaction.
    let item = error as { code?: string; cause?: unknown } | undefined;
    let unique = false;
    for (let depth = 0; item && depth < 4; depth++, item = item.cause as typeof item) {
      if (item.code === "23505" || item.code === "SQLITE_CONSTRAINT_UNIQUE") unique = true;
    }
    if (!unique) throw error;
    const winner = await transaction(function* (tx) { return yield* resolveAttempt(tx); });
    if (!winner) throw error;
    return publicAttempt(winner); // Never acquire container-creation ownership by losing a race.
  }
  const attempt = authorized.row;
  if (!resumable(attempt) && !unstarted(attempt)) return publicAttempt(attempt);
  const id = attempt.id;
  const transition = (from: string, values: Record<string, unknown>) =>
    transaction(function* (tx) { return (yield tx.update(instagramPublishAttempts).set({ ...values, updatedAt: now() })
      .where(and(eq(instagramPublishAttempts.id, id), eq(instagramPublishAttempts.status, from)))
      .returning({ id: instagramPublishAttempts.id })).length === 1; });
  const result = () => transaction(function* (tx) {
    return publicAttempt((yield tx.select().from(instagramPublishAttempts).where(eq(instagramPublishAttempts.id, id)))[0]);
  });
  const client = new InstagramClient(accessToken, transport, env);
  // GET /me is repeatable. Failure leaves unclaimed evidence intact, and must not
  // overwrite another invocation's claim while this preflight was in flight.
  await client.verifyAccount();
  const adapter = new InstagramPublishingAdapter(client, pause, env);
  let containerId = attempt.containerId;
  if (!containerId) {
    const claimed = await transaction(function* (tx) {
      yield* authorizeActor(tx);
      const current = yield* snapshot(tx);
      if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Approved media changed before provider entry");
      return (yield tx.update(instagramPublishAttempts).set({ providerEntryState: "claimed", updatedAt: now() })
        .where(and(eq(instagramPublishAttempts.id, id), eq(instagramPublishAttempts.status, "pending"),
          eq(instagramPublishAttempts.providerEntryState, "unclaimed"), isNull(instagramPublishAttempts.containerId)))
        .returning({ id: instagramPublishAttempts.id })).length === 1;
    });
    // Irreversible claim: no lease, timeout, or replay can supersede this owner.
    // A crash after commit remains ambiguous until container identity is durable.
    if (!claimed) return result();
    try {
      containerId = await adapter.createImageContainer(INSTAGRAM_VAULT_ACCOUNT_ID, attempt.mediaUrl, attempt.caption);
      if (!await transition("pending", { containerId, status: "container_created" })) return result();
    } catch (error) {
      await transition("pending", { status: "failed", lastError: safeKind(error) });
      return result();
    }
  }

  if (attempt.status !== "ready") {
    await transition("container_created", { status: "processing" });
    try {
      const ready = await adapter.waitForReady(containerId);
      if (!ready) return result();
      await transition("processing", { status: "ready", lastError: null });
    } catch (error) {
      if (error instanceof InstagramClientError && error.kind === "invalid_media") await transition("processing", { status: "failed", lastError: safeKind(error) });
      else await transition("processing", { lastError: safeKind(error) });
      return result();
    }
  }

  // This is the sole publish claim. Concurrent pollers may check readiness, but only one
  // can cross ready -> publishing; a crashed/unknown publish is never automatically retried.
  if (!await transition("ready", { status: "publishing" })) return result();
  try {
    const publishedMediaId = await adapter.publishContainer(INSTAGRAM_VAULT_ACCOUNT_ID, containerId);
    await transition("publishing", { status: "published", publishedMediaId, publishedAt: now(), lastError: null });
  } catch (error) {
    await transition("publishing", { status: "reconciliation_required", lastError: safeKind(error) });
  }
  return result();
}
