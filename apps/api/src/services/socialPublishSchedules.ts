import type { DbClient } from "../db/client";
import { socialId, socialPublishScheduleSchema } from "../validation/socialContent";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { createSocialPublishScheduleRepository } from "../repositories/social-content/publishSchedules";
import { createSocialPublishValidation } from "./socialPublishValidation";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";

/** Requested publication time only. No execution, job, or provider dependencies. */
export function createSocialPublishScheduleService(
  db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite", now: () => number = Date.now,
) {
  const schedules = createSocialPublishScheduleRepository(db, driver);
  const intents = createSocialPublishIntentRepository(db, driver);
  const validation = createSocialPublishValidation(db, driver);
  return {
    async create(value: unknown, actorId: string) {
      const input = socialPublishScheduleSchema.parse(value);
      socialId.parse(actorId);
      function* replay(tx: any) {
        const row = yield* schedules.findByRequestId(tx, input.requestId);
        if (row) {
          if (row.publishIntentId !== input.publishIntentId || row.requestedPublicationAt !== input.requestedPublicationAt || row.requestedByAdminUserId !== actorId) {
            throw new ConflictError("Publish schedule request identity does not match");
          }
          return row; // Historical identity, even after the requested time has passed.
        }
        if (yield* schedules.findByIntentId(tx, input.publishIntentId)) throw new ConflictError("Publish intent already has a schedule");
        return null;
      }
      const existing = await schedules.transaction(function* (tx) {
        yield* validation.authorize(tx, actorId);
        return yield* replay(tx);
      });
      if (existing) return existing;
      const requireFuture = () => {
        if (Date.parse(input.requestedPublicationAt) <= now()) throw new BadRequestError("Requested publication time must be in the future");
      };
      requireFuture();
      function* snapshot(tx: any): Generator<any, any, any> {
        const intent = yield* intents.findById(tx, input.publishIntentId);
        if (!intent) throw new NotFoundError("Publish intent not found");
        const approved = yield* validation.snapshot(tx, intent.approvalId);
        return { intent, ...approved };
      }
      const before = await schedules.transaction(snapshot);
      await createSocialContentPreparationService(db, driver).validatePreparedImageCurrent(before.approval.contentId, before.image.id);
      return schedules.transaction(function* (tx) {
        yield* validation.authorize(tx, actorId);
        const completed = yield* replay(tx);
        if (completed) return completed;
        const current = yield* snapshot(tx);
        if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Approved media changed before schedule creation");
        requireFuture();
        const inserted = yield* schedules.insert(tx, { ...input, requestedByAdminUserId: actorId });
        if (inserted) return inserted;
        const winner = yield* replay(tx);
        if (!winner) throw new ConflictError("Publish schedule creation conflicted");
        return winner;
      });
    },
  };
}
