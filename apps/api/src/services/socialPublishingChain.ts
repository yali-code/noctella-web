import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { socialId } from "../validation/socialContent";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { NotFoundError } from "./errors";

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : (value as string | null | undefined) ?? null;

/** Ambiguous provider states are shown for manual investigation only; nothing here can act on them. */
export function requiresManualReconciliation(attempt: { status: string; providerEntryState: string | null; containerId: string | null }) {
  if (attempt.status === "publishing" || attempt.status === "reconciliation_required") return true;
  if (attempt.status === "published" || attempt.status === "failed") return false;
  return attempt.providerEntryState === null || (attempt.providerEntryState === "claimed" && !attempt.containerId);
}

/**
 * Read-only operator view of one content item's durable publishing chain. Selects explicit
 * operator-safe columns only: no claim tokens, payloads, credentials, captions or media URLs.
 */
export function createSocialPublishingChainService(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContents: contents, socialPreparedImages: images, socialContentApprovals: approvals, socialPublishIntents: intents,
    socialPublishSchedules: schedules, socialPublishScheduleExecutions: executions, backgroundJobs: jobs,
    instagramPublishAttempts: attempts } = sync ? sqlite : postgres;
  const { transaction } = createSocialContentRepository(db, driver);
  return {
    get(contentId: string) {
      socialId.parse(contentId);
      return transaction(function* (tx) {
        const [content] = yield tx.select({ id: contents.id, status: contents.status, version: contents.version,
          platform: contents.platform, accountLabel: contents.accountLabel }).from(contents).where(eq(contents.id, contentId));
        if (!content) throw new NotFoundError("Social content not found");
        const preparedImages = yield tx.select({ id: images.id, sourcePhotoId: images.sourcePhotoId, recipeVersion: images.recipeVersion,
          outputPath: images.outputPath }).from(images).where(eq(images.contentId, contentId));
        const approvalRows = yield tx.select({ id: approvals.id, preparedImageId: approvals.preparedImageId, contentVersion: approvals.contentVersion,
          approvedAt: approvals.approvedAt }).from(approvals).where(eq(approvals.contentId, contentId)).orderBy(desc(approvals.approvedAt));
        const chain = [];
        for (const approval of approvalRows) {
          const [intent] = yield tx.select({ id: intents.id, createdAt: intents.createdAt }).from(intents).where(eq(intents.approvalId, approval.id));
          const [schedule] = intent ? (yield tx.select({ id: schedules.id, requestedPublicationAt: schedules.requestedPublicationAt, createdAt: schedules.createdAt })
            .from(schedules).where(eq(schedules.publishIntentId, intent.id))) : [];
          const [execution] = schedule ? (yield tx.select({ id: executions.id, backgroundJobId: executions.backgroundJobId,
            instagramAttemptId: executions.instagramAttemptId, createdAt: executions.createdAt }).from(executions).where(eq(executions.scheduleId, schedule.id))) : [];
          const [job] = execution?.backgroundJobId ? (yield tx.select({ id: jobs.id, status: jobs.status, attemptCount: jobs.attemptCount,
            maxAttempts: jobs.maxAttempts, lastError: jobs.lastError, runAfter: jobs.runAfter, completedAt: jobs.completedAt, updatedAt: jobs.updatedAt })
            .from(jobs).where(eq(jobs.id, execution.backgroundJobId))) : [];
          // Approval binding is unique, so this is the one attempt for the approval, whichever path created it.
          const [attempt] = yield tx.select({ id: attempts.id, status: attempts.status, providerEntryState: attempts.providerEntryState,
            containerId: attempts.containerId, lastError: attempts.lastError, publishedAt: attempts.publishedAt, updatedAt: attempts.updatedAt })
            .from(attempts).where(eq(attempts.approvalId, approval.id));
          chain.push({
            id: approval.id, preparedImageId: approval.preparedImageId, contentVersion: approval.contentVersion, approvedAt: iso(approval.approvedAt),
            current: content.status === "approved" && content.version === approval.contentVersion + 1,
            intent: intent ? { id: intent.id, createdAt: iso(intent.createdAt) } : null,
            schedule: schedule ? { id: schedule.id, requestedPublicationAt: iso(schedule.requestedPublicationAt), createdAt: iso(schedule.createdAt) } : null,
            execution: execution ? { id: execution.id, createdAt: iso(execution.createdAt) } : null,
            job: job ? { id: job.id, status: job.status, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, lastError: job.lastError,
              runAfter: iso(job.runAfter), completedAt: iso(job.completedAt), updatedAt: iso(job.updatedAt) } : null,
            attempt: attempt ? { id: attempt.id, origin: execution?.instagramAttemptId === attempt.id ? "scheduled" as const : "direct" as const,
              status: attempt.status, providerEntryState: attempt.providerEntryState, hasContainer: !!attempt.containerId,
              lastError: attempt.lastError, publishedAt: iso(attempt.publishedAt), updatedAt: iso(attempt.updatedAt),
              requiresManualReconciliation: requiresManualReconciliation(attempt) } : null,
          });
        }
        return { content, preparedImages, approvals: chain };
      });
    },
  };
}
