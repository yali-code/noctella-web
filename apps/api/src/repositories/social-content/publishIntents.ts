import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";

export interface SocialPublishIntent {
  id: string;
  requestId: string;
  approvalId: string;
  requestedByAdminUserId: string;
  createdAt: string;
}
type Insert = Omit<SocialPublishIntent, "id" | "createdAt">;
const result = (row: any): SocialPublishIntent | null => row ? {
  ...row, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
} : null;

/** Insert/read only. Unique conflicts are resolved without aborting PostgreSQL transactions. */
export function createSocialPublishIntentRepository(db: DbClient, driver: string) {
  const { socialPublishIntents: intents } = driver === "sqlite" || driver === "test-memory" ? sqlite : postgres;
  return {
    transaction: createSocialContentRepository(db, driver).transaction,
    *insert(tx: any, input: Insert): SocialWork<SocialPublishIntent | null> {
      const [row] = yield tx.insert(intents).values({
        id: randomUUID(), requestId: input.requestId, approvalId: input.approvalId,
        requestedByAdminUserId: input.requestedByAdminUserId,
      }).onConflictDoNothing().returning();
      return result(row);
    },
    *findByRequestId(tx: any, requestId: string): SocialWork<SocialPublishIntent | null> {
      return result((yield tx.select().from(intents).where(eq(intents.requestId, requestId)))[0]);
    },
    *findByApprovalId(tx: any, approvalId: string): SocialWork<SocialPublishIntent | null> {
      return result((yield tx.select().from(intents).where(eq(intents.approvalId, approvalId)))[0]);
    },
  };
}
