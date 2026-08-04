import { and, eq, isNull, sql } from "drizzle-orm";
import { AiProductIntakeStatus } from "@noctella/shared";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import type {
  AiProductIntakeApplyInput,
  AiProductIntakeApplyResult,
  AiProductIntakeCancelInput,
  AiProductIntakeCancelResult,
  AiProductIntakeCreateInput,
  AiProductIntakeListQuery,
  AiProductIntakeRecord,
  AiProductIntakeRepository,
} from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
  value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution): Result<any[]> =>
  execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);

/**
 * Sprint 94 correction: the single production implementation of the guarded
 * apply/finalization UPDATE - execution-aware so it can run either as a
 * plain async call against the outer db (execution="asynchronous", used by
 * the standalone repository's applyWithExpectedState below) or synchronously/
 * asynchronously against a locked transaction's tx handle (used directly by
 * services/aiIntakeApplyTransactionCapabilityForDb.ts). This is the one
 * production source of truth for the finalization rule - never duplicated;
 * both callers delegate to this function rather than each re-expressing the
 * WHERE/SET clauses independently.
 */
export function applyIntakeWithExpectedStateInTransaction(
  db: any,
  schema: Schema,
  execution: Execution,
  input: AiProductIntakeApplyInput,
): Result<AiProductIntakeApplyResult> {
  const table = (schema as Record<string, any>).aiProductIntakes;
  return then(
    rows(
      db
        .update(table)
        .set({
          status: AiProductIntakeStatus.Applied,
          resultProductId: input.resultProductId,
          appliedAt: input.appliedAt,
          appliedByAdminUserId: input.appliedByAdminUserId,
          updatedAt: input.updatedAt,
        })
        .where(and(eq(table.id, input.id), eq(table.status, AiProductIntakeStatus.Open), isNull(table.resultProductId)))
        .returning(),
      execution,
    ),
    (changed: any[]) => {
      if (changed.length) return { updated: true, row: changed[0] as AiProductIntakeRecord };
      return then(rows(db.select().from(table).where(eq(table.id, input.id)), execution), (existingRows: any[]) => {
        const existing = existingRows[0];
        if (!existing) return { updated: false, conflict: { field: "id" as const, message: "AI product intake not found" } };
        if (existing.resultProductId !== null) {
          return {
            updated: false,
            conflict: { field: "resultProductId" as const, message: "This intake already has a result Product" },
            row: existing as AiProductIntakeRecord,
          };
        }
        return {
          updated: false,
          conflict: { field: "status" as const, message: `Expected status "${AiProductIntakeStatus.Open}" but found "${existing.status}"` },
          row: existing as AiProductIntakeRecord,
        };
      });
    },
  );
}

/**
 * Sprint 90: no dedicated transaction capability - every operation here is a
 * single statement, so it runs directly against whatever db handle (app
 * singleton or a repository-bundle's tx handle) is passed in, exactly as
 * services/aiDrafts.ts's non-approval functions already do. Takes an
 * explicit schema module (mirroring repositories/ai-draft/drizzle.ts and
 * repositories/product-read/drizzle.ts) so the same code works against
 * either dialect's table object.
 */
export function createDrizzleAiProductIntakeRepository(db: any, schema: Schema): AiProductIntakeRepository {
  const table = (schema as Record<string, any>).aiProductIntakes;
  return {
    async create(input: AiProductIntakeCreateInput): Promise<AiProductIntakeRecord> {
      await db.insert(table).values({
        id: input.id,
        status: AiProductIntakeStatus.Open,
        createdByAdminUserId: input.createdByAdminUserId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      const [row] = await db.select().from(table).where(eq(table.id, input.id));
      return row as AiProductIntakeRecord;
    },

    async findById(id: string): Promise<AiProductIntakeRecord | null> {
      const [row] = await db.select().from(table).where(eq(table.id, id));
      return (row as AiProductIntakeRecord) ?? null;
    },

    async list(query: AiProductIntakeListQuery): Promise<AiProductIntakeRecord[]> {
      const whereClause = query.status ? eq(table.status, query.status) : undefined;
      const rows = await db
        .select()
        .from(table)
        .where(whereClause)
        .orderBy(table.createdAt)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return rows as AiProductIntakeRecord[];
    },

    async count(query: AiProductIntakeListQuery): Promise<number> {
      const whereClause = query.status ? eq(table.status, query.status) : undefined;
      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(table)
        .where(whereClause);
      return Number(total);
    },

    async cancelWithExpectedState(input: AiProductIntakeCancelInput): Promise<AiProductIntakeCancelResult> {
      const changed = await db
        .update(table)
        .set({
          status: AiProductIntakeStatus.Cancelled,
          cancelledAt: input.cancelledAt,
          cancelledByAdminUserId: input.cancelledByAdminUserId,
          cancellationReason: input.cancellationReason ?? null,
          updatedAt: input.updatedAt,
        })
        .where(and(eq(table.id, input.id), eq(table.status, input.expectedStatus)))
        .returning();

      if (changed.length) return { updated: true, row: changed[0] as AiProductIntakeRecord };

      const [existing] = await db.select().from(table).where(eq(table.id, input.id));
      if (!existing) return { updated: false, conflict: { field: "id", message: "AI product intake not found" } };
      return {
        updated: false,
        conflict: { field: "status", message: `Expected status "${input.expectedStatus}" but found "${existing.status}"` },
        row: existing as AiProductIntakeRecord,
      };
    },

    async applyWithExpectedState(input: AiProductIntakeApplyInput): Promise<AiProductIntakeApplyResult> {
      // Delegates to the one production implementation - see
      // applyIntakeWithExpectedStateInTransaction above, also called
      // directly (transaction-scoped) by
      // services/aiIntakeApplyTransactionCapabilityForDb.ts.
      return applyIntakeWithExpectedStateInTransaction(db, schema, "asynchronous", input) as Promise<AiProductIntakeApplyResult>;
    },
  };
}
