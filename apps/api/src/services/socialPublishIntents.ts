import { eq } from "drizzle-orm";
import type { AdminRole } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { hasPermission } from "../auth/permissions";
import { socialId, socialPublishIntentSchema } from "../validation/socialContent";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { createSocialContentApprovalRepository } from "../repositories/social-content/approvals";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "./errors";

/** Records intent only: no credentials, provider, attempt, or background execution dependencies. */
export function createSocialPublishIntentService(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContents, adminUsers } = sync ? sqlite : postgres;
  const intents = createSocialPublishIntentRepository(db, driver);
  const approvals = createSocialContentApprovalRepository(db, driver);
  const prepared = createPreparedImageRepository(db, driver);
  return {
    async create(value: unknown, actorId: string) {
      const input = socialPublishIntentSchema.parse(value);
      socialId.parse(actorId);
      function* authorize(tx: any): Generator<any, void, any> {
        let query = tx.select().from(adminUsers).where(eq(adminUsers.id, actorId));
        if (!sync) query = query.for("share");
        const [actor] = yield query;
        if (!actor || actor.status !== "active" || !hasPermission(actor.role as AdminRole, "products.publish")) {
          throw new UnauthorizedError("Publishing authorization required");
        }
      }
      function* replay(tx: any) {
        const row = yield* intents.findByRequestId(tx, input.requestId);
        if (row) {
          if (row.approvalId !== input.approvalId || row.requestedByAdminUserId !== actorId) {
            throw new ConflictError("Publish intent request identity does not match");
          }
          return row; // Historical intent, not a claim of continuing artifact validity.
        }
        if (yield* intents.findByApprovalId(tx, input.approvalId)) throw new ConflictError("Approval already has a publish intent");
        return null;
      }
      const existing = await intents.transaction(function* (tx) { yield* authorize(tx); return yield* replay(tx); });
      if (existing) return existing;
      function* snapshot(tx: any): Generator<any, any, any> {
        const approval = yield* approvals.find(tx, input.approvalId);
        if (!approval) throw new NotFoundError("Human Approval not found");
        let query = tx.select().from(socialContents).where(eq(socialContents.id, approval.contentId));
        if (!sync) query = query.for("update");
        const [content] = yield query;
        if (!content) throw new NotFoundError("Social content not found");
        if (content.status !== "approved" || content.version !== approval.contentVersion + 1) throw new ConflictError("Approved content changed");
        if (content.platform !== "instagram" || content.accountLabel !== "vault") throw new BadRequestError("Unsupported publishing target");
        if (typeof content.caption !== "string" || !content.caption.trim() || content.caption.length > 2200) throw new BadRequestError("Invalid approved caption");
        const image = yield* prepared.find(tx, approval.contentId, approval.preparedImageId);
        const source = yield* prepared.source(tx, approval.contentId, image.sourcePhotoId);
        return { approval, content, image, source };
      }
      const before = await intents.transaction(snapshot);
      await createSocialContentPreparationService(db, driver).validatePreparedImageCurrent(before.approval.contentId, before.image.id);
      return intents.transaction(function* (tx) {
        yield* authorize(tx);
        const completed = yield* replay(tx);
        if (completed) return completed;
        const current = yield* snapshot(tx);
        if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Approved media changed before intent creation");
        const inserted = yield* intents.insert(tx, { ...input, requestedByAdminUserId: actorId });
        if (inserted) return inserted;
        const winner = yield* replay(tx);
        if (!winner) throw new ConflictError("Publish intent creation conflicted");
        return winner;
      });
    },
  };
}
