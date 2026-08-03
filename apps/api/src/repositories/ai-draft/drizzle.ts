import { and, eq } from "drizzle-orm";
import { AiDraftStatus } from "@noctella/shared";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { AiDraftApprovalRepository, SynchronousAiDraftApprovalRepository } from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const first = (q: any, execution: Execution): Result<any> =>
  then(rows(q, execution), (values) => values[0] ?? null);

/**
 * Sprint 89: mirrors the exact atomic-conditional-update shape proven safe
 * cross-dialect by repositories/product-write/drizzle.ts's
 * updateWithExpectedVersion (Sprint 88) and repositories/inventory/
 * drizzleCore.ts's updateWithVersion - one UPDATE ... WHERE id = ? AND
 * status = 'pending_review' RETURNING ..., decided solely by the returned
 * row count. The diagnostic read below only runs after zero rows changed.
 */
export function createDrizzleAiDraftApprovalRepository(
  db: any,
  schema: Schema,
  execution: Execution = "asynchronous",
): AiDraftApprovalRepository | SynchronousAiDraftApprovalRepository {
  const table = (schema as Record<string, any>).aiListingDrafts;
  return {
    findById(id: string) {
      return then(first(db.select().from(table).where(eq(table.id, id)), execution), (row) => row ?? null) as any;
    },
    claimAndApprove({ id, reviewedByAdminUserId, reviewedAt, updatedAt }) {
      return then(
        rows(
          db
            .update(table)
            .set({ status: AiDraftStatus.Approved, reviewedByAdminUserId, reviewedAt, updatedAt })
            .where(and(eq(table.id, id), eq(table.status, AiDraftStatus.PendingReview)))
            .returning(),
          execution,
        ),
        (changed: any[]) => {
          if (changed.length) return { updated: true, row: changed[0] };
          return then(first(db.select().from(table).where(eq(table.id, id)), execution), (existing) => {
            if (!existing) return { updated: false, conflict: { field: "id" as const, message: "AI draft not found" } };
            return {
              updated: false,
              conflict: { field: "status" as const, message: `Only a Pending Review draft can be approved (current status: "${existing.status}")` },
            };
          });
        },
      ) as any;
    },
  };
}
