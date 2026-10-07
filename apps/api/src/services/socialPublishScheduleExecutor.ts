import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { socialId } from "../validation/socialContent";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialPublishIntentRepository } from "../repositories/social-content/publishIntents";
import { SOCIAL_PUBLISH_SCHEDULE_JOB_TYPE } from "../repositories/social-content/publishScheduleExecutions";
import { InstagramClientError, type InstagramTransport, INSTAGRAM_ACCOUNT_LABEL, INSTAGRAM_CHANNEL, INSTAGRAM_VAULT_ACCOUNT_ID } from "../integrations/instagram/types";
import { createSocialPublishValidation } from "./socialPublishValidation";
import { createSocialContentPreparationService } from "./socialContentPreparation";
import { publishInstagramImage } from "./instagramPublishing";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "./errors";

const payloadSchema = z.object({ scheduleId: socialId }).strict();
const ownershipLost = Symbol("ownershipLost");
const resumableStatuses = ["container_created", "processing", "ready"];
class ProviderOutcomeError { constructor(readonly type: "Temporary" | "Permanent" | "Conflict") {} }

/**
 * Validates the canonical chain, durably binds the one approval-bound Instagram attempt
 * for this execution, and only then enters the existing publishing state machine for that
 * same attempt, fenced by the original job claim.
 */
export function createSocialPublishScheduleExecutor(
  db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite", now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env, transport?: InstagramTransport, pause?: (ms: number) => Promise<void>,
) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { backgroundJobs: jobs, socialPublishScheduleExecutions: executions, socialPublishSchedules: schedules,
    marketplaceConnections: connections, products, instagramPublishAttempts: attempts } = sync ? sqlite : postgres;
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
        const approvalId = current.approved.approval.id;
        // Server-owned identity: one execution can only ever resolve this one keyed attempt.
        const idempotencyKey = `social-publish-execution:${current.execution.id}`;
        const owned = function* (tx: any): Generator<any, void, any> {
          let jobQuery = tx.select({ id: jobs.id }).from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.status, "processing"), eq(jobs.claimToken, originalClaimToken)));
          if (!sync) jobQuery = jobQuery.for("share");
          if (!(yield jobQuery)[0]) throw ownershipLost;
        };
        const bind = function* (tx: any, attemptId: string): Generator<any, void, any> {
          yield* owned(tx);
          let executionQuery = tx.select().from(executions).where(and(eq(executions.id, current.execution.id),
            eq(executions.scheduleId, current.schedule.id), eq(executions.backgroundJobId, jobId)));
          if (!sync) executionQuery = executionQuery.for("update");
          const [execution] = yield executionQuery;
          if (!execution) throw new ConflictError("Schedule job binding changed");
          if (execution.instagramAttemptId === attemptId) return;
          if (execution.instagramAttemptId) throw new ConflictError("Schedule execution is bound to another attempt");
          const bound = yield tx.update(executions).set({ instagramAttemptId: attemptId })
            .where(and(eq(executions.id, execution.id), isNull(executions.instagramAttemptId))).returning({ id: executions.id });
          if (bound.length !== 1) throw new ConflictError("Schedule execution attempt binding changed");
        };
        // Attempt creation and binding share one transaction behind the original claim; no provider entry.
        await publishInstagramImage(db, { approvalId, idempotencyKey }, current.schedule.requestedByAdminUserId, undefined, env, undefined, bind);
        // Terminal or lost-race resolutions skip the hook; bind the exact keyed attempt under the same fence.
        const instagramAttemptId = await repository.transaction(function* (tx) {
          const [attempt] = yield tx.select({ id: attempts.id, approvalId: attempts.approvalId }).from(attempts)
            .where(eq(attempts.idempotencyKey, idempotencyKey));
          if (!attempt || attempt.approvalId !== approvalId) throw new ConflictError("Execution attempt unavailable");
          yield* bind(tx, attempt.id);
          return attempt.id as string;
        });
        // The binding above is committed. Only now does the existing state machine resolve the same
        // keyed attempt and decide provider entry; the original claim fences unclaimed -> claimed.
        const attempt = await publishInstagramImage(db, { approvalId, idempotencyKey }, current.schedule.requestedByAdminUserId,
          transport, env, pause, undefined, owned);
        if (attempt.id !== instagramAttemptId) throw new ConflictError("Execution attempt changed");
        // Success requires publication. A durable container may resume; ambiguity never replays.
        if (attempt.status !== "published") {
          throw new ProviderOutcomeError(attempt.containerId && resumableStatuses.includes(attempt.status) ? "Temporary"
            : attempt.status === "failed" ? "Permanent" : "Conflict");
        }
        return { executionId: current.execution.id, scheduleId: current.schedule.id, backgroundJobId: jobId,
          publishIntentId: current.intent.id, approvalId, contentId: current.approved.content.id,
          preparedImageId: current.approved.image.id, connectionId: current.connection.id, instagramAttemptId };
      } catch (error) {
        if (error === ownershipLost) return null;
        const type = error instanceof ProviderOutcomeError ? error.type : error instanceof BadRequestError ? "Validation" : error instanceof ConflictError ? "Conflict"
          : error instanceof NotFoundError ? "NotFound" : error instanceof UnauthorizedError ? "Authorization"
          : error instanceof InstagramClientError && !error.retryable ? "Permanent" : "Temporary";
        // Existing job failure machinery consumes these fields; never persist raw errors/paths.
        // Wording only: lets operators tell provider/publishing outcomes from canonical validation failures.
        const message = error instanceof ProviderOutcomeError || error instanceof InstagramClientError
          ? "Social schedule publishing failed" : "Social schedule execution validation failed";
        throw { type, message, retryable: type === "Temporary" };
      }
    },
  };
}
