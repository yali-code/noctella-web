import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";

export interface SocialPublishSchedule {
  id: string;
  requestId: string;
  publishIntentId: string;
  requestedByAdminUserId: string;
  requestedPublicationAt: string;
  createdAt: string;
}
type Insert = Omit<SocialPublishSchedule, "id" | "createdAt">;
const result = (row: any): SocialPublishSchedule | null => row ? {
  ...row, requestedPublicationAt: row.requestedPublicationAt instanceof Date ? row.requestedPublicationAt.toISOString() : row.requestedPublicationAt, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
} : null;

/** Insert/read only. Unique conflicts are resolved without aborting PostgreSQL transactions. */
export function createSocialPublishScheduleRepository(db: DbClient, driver: string) {
  const { socialPublishSchedules: schedules } = driver === "sqlite" || driver === "test-memory" ? sqlite : postgres;
  return {
    transaction: createSocialContentRepository(db, driver).transaction,
    *insert(tx: any, input: Insert): SocialWork<SocialPublishSchedule | null> {
      const [row] = yield tx.insert(schedules).values({
        id: randomUUID(), requestId: input.requestId, publishIntentId: input.publishIntentId,
        requestedPublicationAt: driver === "sqlite" || driver === "test-memory" ? input.requestedPublicationAt : new Date(input.requestedPublicationAt),
        requestedByAdminUserId: input.requestedByAdminUserId,
      }).onConflictDoNothing().returning();
      return result(row);
    },
    *findByRequestId(tx: any, requestId: string): SocialWork<SocialPublishSchedule | null> {
      return result((yield tx.select().from(schedules).where(eq(schedules.requestId, requestId)))[0]);
    },
    *findByIntentId(tx: any, publishIntentId: string): SocialWork<SocialPublishSchedule | null> {
      return result((yield tx.select().from(schedules).where(eq(schedules.publishIntentId, publishIntentId)))[0]);
    },
  };
}
