import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { socialId } from "../validation/socialContent";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE } from "../repositories/social-content/publishScheduleExecutions";
import { INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_CHANNEL, INSTAGRAM_VAULT_ACCOUNT_ID } from "../integrations/instagram/types";
import { createSocialPublishValidation } from "./socialPublishValidation";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "./errors";

const payloadSchema = z.object({ scheduleId: socialId }).strict();

/** Local validation only. Returned IDs are not a durable grant to publish. */
export function createSocialPublishScheduleExecutor(
  db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite", now: () => number = Date.now,
) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { backgroundJobs: jobs, socialPublishScheduleExecutions: executions, socialPublishSchedules: schedules,
    marketplaceConnections: connections, products } = sync ? sqlite : postgres;
  const repository = createSocialContentRepository(db, driver);
  const intents = createSocialPublishIntentRepository(db, driver);
  const validation = createSocialPublishValidation(db, driver);
  const preparation = createSocialContentPreparationService(db, driver);
  return {
    async execute(jobId: string, originalClaimToken: string | null) {
      if (typeof originalClaimToken !== "string" || !originalClaimToken) return null;
      const snapshot = () => repository.transaction(function* (tx) {
        let jobQuery = tx.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.status, "processing"), eq(jobs.claimToken, originalClaimToken)));
        if (!sync) jobQuery = jobQuery.for("share");
        const [job] = yield jobQuery;
        if (!job) return null;
        if (job.type !== SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE) throw new BadRequestError("Invalid schedule job");
        let raw: unknown;
        try { raw = typeof job.payloadSnapshot === "string" ? JSON.parse(job.payloadSnapshot) : job.payloadSnapshot; }
        catch { throw new BadRequestError("Invalid schedule payload"); }
        const payload = payloadSchema.safeParse(raw);
        if (!payload.success) throw new BadRequestError("Invalid schedule payload");
        const [execution] = yield tx.select().from(executions).where(and(eq(executions.scheduleId, payload.data.scheduleId), eq(executions.backgroundJobId, jobId)));
        if (!execution || job.idempotencyKey !== `social-publish-schedule:${execution.id}`
          || job.channel != null || job.productId != null || job.externalListingId != null) throw new ConflictError("Schedule job binding changed");
        const [schedule] = yield tx.select().from(schedules).where(eq(schedules.id, execution.scheduleId));
        if (!schedule) throw new NotFoundError("Publish schedule not found");
        const requestedAt = schedule.requestedPublicationAt instanceof Date ? schedule.requestedPublicationAt.getTime() : Date.parse(schedule.requestedPublicationAt);
        if (!Number.isFinite(requestedAt) || requestedAt > now()) throw new ConflictError("Publish schedule is not due");
        const intent = yield* intents.findById(tx, schedule.publishIntentId);
        if (!intent) throw new NotFoundError("Publish intent not found");
        yield* validation.authorize(tx, schedule.requestedByAdminUserId);
        const approved = yield* validation.snapshot(tx, intent.approvalId);
        const [product] = yield tx.select({ id: products.id }).from(products).where(eq(products.id, approved.source.productId));
        if (!product) throw new NotFoundError("Source product not found");
        // Select identity only: no encrypted credential is read or decrypted here.
        const [connection] = yield tx.select({ id: connections.id, externalAccountId: connections.externalAccountId, status: connections.status })
          .from(connections).where(and(eq(connections.channel, INSTAGRAM_CHANNEL), eq(connections.accountLabel, INSTAGRAM_ACCOUNT_LABEL)));
        if (!connection || connection.externalAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID || connection.status !== "connected") {
          throw new BadRequestError("Canonical Instagram connection unavailable");
        }
        return { execution, schedule, intent, approved, connection };
      });
      try {
        const before = await snapshot();
        if (!before) return null;
        await preparation.validatePreparedImageCurrent(before.approved.content.id, before.approved.image.id);
        // Filesystem inspection is asynchronous. Recheck the original claim and full chain afterwards.
        const current = await snapshot();
        if (!current) return null;
        if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Schedule execution state changed");
        return { executionId: current.execution.id, scheduleId: current.schedule.id, backgroundJobId: jobId,
          publishIntentId: current.intent.id, approvalId: current.approved.approval.id,
          contentId: current.approved.content.id, preparedImageId: current.approved.image.id, connectionId: current.connection.id };
      } catch (error) {
        const type = error instanceof BadRequestError ? "Validation" : error instanceof ConflictError ? "Conflict"
          : error instanceof NotFoundError ? "NotFound" : error instanceof UnauthorizedError ? "Authorization" : "Temporary";
        // Existing job failure machinery consumes these fields; never persist raw errors/paths.
        throw { type, message: "Social schedule execution validation failed", retryable: type === "Temporary" };
      }
    },
  };
}
