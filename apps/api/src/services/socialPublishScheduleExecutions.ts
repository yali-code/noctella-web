import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { socialId } from "../validation/socialContent";
import { createSocialPublishScheduleExecutionRepository } from "../repositories/social-content/publishScheduleExecutions";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { createSocialPublishValidation } from "./socialPublishValidation";
import { ConflictError, NotFoundError } from "./errors";

/** Internal due-schedule handoff only: no jobs, attempts, credentials or provider entry. */
export function createSocialPublishScheduleExecutionService(
  db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite", now: () => number = Date.now,
) {
  const { socialPublishSchedules: schedules } = driver === "sqlite" || driver === "test-memory" ? sqlite : postgres;
  const executions = createSocialPublishScheduleExecutionRepository(db, driver);
  const intents = createSocialPublishIntentRepository(db, driver);
  const validation = createSocialPublishValidation(db, driver);
  return {
    async create(scheduleId: string) {
      socialId.parse(scheduleId);
      return executions.transaction(function* (tx) {
        const [schedule] = yield tx.select().from(schedules).where(eq(schedules.id, scheduleId));
        if (!schedule) throw new NotFoundError("Publish schedule not found");
        const requestedAt = schedule.requestedPublicationAt instanceof Date
          ? schedule.requestedPublicationAt.getTime() : Date.parse(schedule.requestedPublicationAt);
        if (!Number.isFinite(requestedAt) || !(requestedAt <= now())) throw new ConflictError("Publish schedule is not due");
        const intent = yield* intents.findById(tx, schedule.publishIntentId);
        if (!intent) throw new NotFoundError("Publish intent not found");
        // Cheap canonical checks only; artifact bytes and execution authorization belong to the executor.
        yield* validation.snapshot(tx, intent.approvalId);
        const existing = yield* executions.findByScheduleId(tx, scheduleId);
        if (existing) return existing;
        const inserted = yield* executions.insert(tx, scheduleId);
        if (inserted) return inserted;
        const winner = yield* executions.findByScheduleId(tx, scheduleId);
        if (!winner) throw new ConflictError("Schedule execution handoff conflicted");
        return winner;
      });
    },
  };
}
