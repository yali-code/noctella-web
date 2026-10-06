import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";

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

/** Insert/read only. Future job and attempt attachment is deliberately unavailable. */
export function createSocialPublishScheduleExecutionRepository(db: DbClient, driver: string) {
  const { socialPublishScheduleExecutions: executions } = driver === "sqlite" || driver === "test-memory" ? sqlite : postgres;
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
  };
}
