import { createSocialPublishValidation } from "./socialPublishValidation";
import type { DbClient } from "../db/client";
import { socialId, socialPublishIntentSchema } from "../validation/socialContent";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { ConflictError } from "./errors";

/** Records intent only: no credentials, provider, attempt, or background execution dependencies. */
export function createSocialPublishIntentService(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  const intents = createSocialPublishIntentRepository(db, driver);
  const validation = createSocialPublishValidation(db, driver);
  return {
    async create(value: unknown, actorId: string) {
      const input = socialPublishIntentSchema.parse(value);
      socialId.parse(actorId);
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
      const existing = await intents.transaction(function* (tx) { yield* validation.authorize(tx, actorId); return yield* replay(tx); });
      if (existing) return existing;
      const before = await intents.transaction((tx) => validation.snapshot(tx, input.approvalId));
      await createSocialContentPreparationService(db, driver).validatePreparedImageCurrent(before.approval.contentId, before.image.id);
      return intents.transaction(function* (tx) {
        yield* validation.authorize(tx, actorId);
        const completed = yield* replay(tx);
        if (completed) return completed;
        const current = yield* validation.snapshot(tx, input.approvalId);
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
