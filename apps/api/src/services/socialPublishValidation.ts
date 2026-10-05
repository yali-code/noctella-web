import { eq } from "drizzle-orm";
import type { AdminRole } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { hasPermission } from "../auth/permissions";
import { createSocialContentApprovalRepository } from "../repositories/social-content/approvals";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "./errors";

/** Shared local authorization/snapshot checks; no execution dependencies. */
export function createSocialPublishValidation(db: DbClient, driver: string) {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContents, adminUsers } = sync ? sqlite : postgres;
  const approvals = createSocialContentApprovalRepository(db, driver);
  const prepared = createPreparedImageRepository(db, driver);
  function* authorize(tx: any, actorId: string): Generator<any, void, any> {
    let query = tx.select().from(adminUsers).where(eq(adminUsers.id, actorId));
    if (!sync) query = query.for("share");
    const [actor] = yield query;
    if (!actor || actor.status !== "active" || !hasPermission(actor.role as AdminRole, "products.publish")) {
      throw new UnauthorizedError("Publishing authorization required");
    }
  }
  function* snapshot(tx: any, approvalId: string): Generator<any, any, any> {
    const approval = yield* approvals.find(tx, approvalId);
    if (!approval) throw new NotFoundError("Human Approval not found");
    let query = tx.select().from(socialContents).where(eq(socialContents.id, approval.contentId));
    if (!sync) query = query.for("update");
    const [content] = yield query;
    if (!content) throw new NotFoundError("Social content not found");
    if (content.status !== "approved" || content.version !== approval.contentVersion + 1) throw new ConflictError("Approved content changed");
    if (content.platform !== "instagram" || content.accountLabel !== "vault") throw new BadRequestError("Unsupported publishing target");
    if (typeof content.caption !== "string" || !content.caption.trim() || content.caption.length > 2200) throw new BadRequestError("Invalid approved caption");
    const image = yield* prepared.find(tx, approval.contentId, approval.preparedImageId);
    const source = yield* prepared.source(tx, approval.contentId, image.sourcePhotoId);
    return { approval, content, image, source };
  }
  return { authorize, snapshot };
}
