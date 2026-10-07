import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { socialId } from "../validation/socialContent";
import { createSocialPublishScheduleExecutionRepository } from "../repositories/social-content/publishScheduleExecutions";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { createSocialPublishValidation } from "./socialPublishValidation";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";

/** Internal due-schedule handoff/binding only: no attempts, credentials or provider entry. */
export function createSocialPublishScheduleExecutionService(
  db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite", now: () => number = Date.now,
) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialPublishSchedules: schedules, socialPublishScheduleExecutions: executionRows, socialPublishIntents: intentRows,
    socialContentApprovals: approvals, socialContents: contents } = sync ? sqlite : postgres;
  const executions = createSocialPublishScheduleExecutionRepository(db, driver);
  const intents = createSocialPublishIntentRepository(db, driver);
  const validation = createSocialPublishValidation(db, driver);
  async function prepare(scheduleId: string, bindJob: boolean) {
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
      if (existing) return bindJob ? yield* executions.bindJob(tx, existing.id) : existing;
      const inserted = yield* executions.insert(tx, scheduleId);
      if (inserted) return bindJob ? yield* executions.bindJob(tx, inserted.id) : inserted;
      const winner = yield* executions.findByScheduleId(tx, scheduleId);
      if (!winner) throw new ConflictError("Schedule execution handoff conflicted");
      return bindJob ? yield* executions.bindJob(tx, winner.id) : winner;
    });
  }
  /**
   * Bounded due-schedule discovery: establishes handoff + job only, never executes them.
   * Schedules with a bound job are done here; the approved-version join only keeps
   * permanently stale schedules from pinning the batch. `enqueue` remains the authority.
   */
  async function discover(limit: number) {
    const dueAt = sync ? new Date(now()).toISOString() : new Date(now());
    const due: { id: string }[] = await executions.transaction(function* (tx) {
      return yield tx.select({ id: schedules.id }).from(schedules)
        .leftJoin(executionRows, eq(executionRows.scheduleId, schedules.id))
        .innerJoin(intentRows, eq(intentRows.id, schedules.publishIntentId))
        .innerJoin(approvals, eq(approvals.id, intentRows.approvalId))
        .innerJoin(contents, eq(contents.id, approvals.contentId))
        .where(and(lte(schedules.requestedPublicationAt, dueAt as any), isNull(executionRows.backgroundJobId),
          eq(contents.status, "approved"), eq(contents.version, sql`${approvals.contentVersion} + 1`)))
        .orderBy(asc(schedules.requestedPublicationAt), asc(schedules.id)).limit(limit);
    });
    const results: { scheduleId: string; outcome: "enqueued" | "rejected"; backgroundJobId?: string; reason?: string }[] = [];
    for (const { id } of due) {
      // Each schedule converges in its own transaction; one stale schedule cannot affect another.
      try {
        const execution = await prepare(id, true);
        results.push({ scheduleId: id, outcome: "enqueued", backgroundJobId: execution.backgroundJobId ?? undefined });
      } catch (error) {
        const reason = error instanceof ConflictError ? "Conflict" : error instanceof NotFoundError ? "NotFound"
          : error instanceof BadRequestError ? "Validation" : "Temporary";
        results.push({ scheduleId: id, outcome: "rejected", reason });
      }
    }
    return results;
  }
  return {
    create: (scheduleId: string) => prepare(scheduleId, false),
    enqueue: (scheduleId: string) => prepare(scheduleId, true),
    discover,
  };
}
