import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";
import { ConflictError } from "../../services/errors";

export const SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE = "social_publish_schedule";

export interface SocialPublishScheduleExecution {
  id: string;
  scheduleId: string;
  backgroundJobId: string | null;
  instagramAttemptId: string | null;
  createdAt: string;
}
const result = (row: any): SocialPublishScheduleExecution | null => row ? {
  ...row, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
} : null;

/** Job creation and attachment share a transaction; attempt attachment remains unavailable. */
export function createSocialPublishScheduleExecutionRepository(db: DbClient, driver: string) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialPublishScheduleExecutions: executions, backgroundJobs: jobs } = sync ? sqlite : postgres;
  return {
    transaction: createSocialContentRepository(db, driver).transaction,
    *findByScheduleId(tx: any, scheduleId: string): SocialWork<SocialPublishScheduleExecution | null> {
      return result((yield tx.select().from(executions).where(eq(executions.scheduleId, scheduleId)))[0]);
    },
    *insert(tx: any, scheduleId: string): SocialWork<SocialPublishScheduleExecution | null> {
      const [row] = yield tx.insert(executions).values({ id: randomUUID(), scheduleId })
        .onConflictDoNothing({ target: executions.scheduleId }).returning();
      return result(row);
    },
    *bindJob(tx: any, executionId: string): SocialWork<SocialPublishScheduleExecution> {
      let query = tx.select().from(executions).where(eq(executions.id, executionId));
      if (!sync) query = query.for("update");
      const [execution] = yield query;
      if (!execution) throw new ConflictError("Schedule execution handoff missing");
      const idempotencyKey = `social-publish-schedule:${execution.id}`;
      if (execution.backgroundJobId) {
        const [job] = yield tx.select().from(jobs).where(eq(jobs.id, execution.backgroundJobId));
        let payload: any;
        try { payload = typeof job?.payloadSnapshot === "string" ? JSON.parse(job.payloadSnapshot) : job?.payloadSnapshot; }
        catch { throw new ConflictError("Schedule execution job binding conflicted"); }
        if (!job || job.type !== SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE || job.idempotencyKey !== idempotencyKey
          || !payload || Array.isArray(payload) || Object.keys(payload).length !== 1 || payload.scheduleId !== execution.scheduleId
          || job.channel != null || job.productId != null || job.externalListingId != null) {
          throw new ConflictError("Schedule execution job binding conflicted");
        }
        return result(execution)!;
      }
      const payload = { scheduleId: execution.scheduleId };
      const [job] = yield tx.insert(jobs).values({
        id: randomUUID(), type: SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE, status: "pending",
        payloadSnapshot: sync ? JSON.stringify(payload) : payload,
        idempotencyKey, runAfter: sync ? new Date().toISOString() : new Date(),
      }).onConflictDoNothing({ target: jobs.idempotencyKey }).returning();
      // An unbound job is not evidence of ownership, even if its payload happens to match.
      if (!job) throw new ConflictError("Schedule execution job key conflicted");
      const [bound] = yield tx.update(executions).set({ backgroundJobId: job.id })
        .where(and(eq(executions.id, execution.id), isNull(executions.backgroundJobId))).returning();
      if (!bound) throw new ConflictError("Schedule execution job binding conflicted");
      return result(bound)!;
    },
  };
}
