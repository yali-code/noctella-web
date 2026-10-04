import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { BadRequestError } from "../../services/errors";
import { createSocialContentRepository } from "./drizzle";
import type { SocialWork } from "./types";

export interface SocialContentApproval {
  id: string;
  requestId: string;
  contentId: string;
  preparedImageId: string;
  contentVersion: number;
  approvedByAdminUserId: string;
  approvedAt: string;
}
export type SocialContentApprovalInsert = Omit<SocialContentApproval, "id" | "approvedAt">;

const result = (row: any): SocialContentApproval => ({
  ...row, approvedAt: row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
});

/** Insert/read only; callers can compose these effects inside their own transaction. */
export function createSocialContentApprovalRepository(db: DbClient, driver: string) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContentApprovals: approvals, socialPreparedImages: images } = sync ? sqlite : postgres;
  return {
    transaction: createSocialContentRepository(db, driver).transaction,
    isRequestConflict(error: unknown): boolean {
      let item = error as { code?: string; constraint?: string; message?: string; cause?: unknown } | undefined;
      for (let depth = 0; item && depth < 4; depth++, item = item.cause as typeof item) {
        if (item.code === "23505" && item.constraint === "idx_social_content_approvals_request_unique") return true;
        if (item.code === "SQLITE_CONSTRAINT_UNIQUE" && item.message?.includes("social_content_approvals.request_id")) return true;
      }
      return false;
    },
    *insert(tx: any, input: SocialContentApprovalInsert): SocialWork<SocialContentApproval> {
      if (!Number.isInteger(input.contentVersion) || input.contentVersion < 1) {
        throw new BadRequestError("Invalid reviewed content version");
      }
      let query = tx.select({ id: images.id }).from(images)
        .where(and(eq(images.id, input.preparedImageId), eq(images.contentId, input.contentId)));
      if (!sync) query = query.for("share");
      if (!(yield query)[0]) throw new BadRequestError("Prepared image does not belong to content");
      // Whitelist persisted fields: ID and time are never caller-controlled.
      const [row] = yield tx.insert(approvals).values({
        id: randomUUID(), requestId: input.requestId, contentId: input.contentId,
        preparedImageId: input.preparedImageId, contentVersion: input.contentVersion,
        approvedByAdminUserId: input.approvedByAdminUserId,
      }).returning();
      return result(row);
    },
    *findByRequestId(tx: any, requestId: string): SocialWork<SocialContentApproval | null> {
      const [row] = yield tx.select().from(approvals).where(eq(approvals.requestId, requestId));
      return row ? result(row) : null;
    },
    *find(tx: any, id: string): SocialWork<SocialContentApproval | null> {
      const [row] = yield tx.select().from(approvals).where(eq(approvals.id, id));
      return row ? result(row) : null;
    },
  };
}
