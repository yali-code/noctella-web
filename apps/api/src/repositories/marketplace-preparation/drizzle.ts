import { and, eq } from "drizzle-orm";
import { marketplacePreparations } from "../../db/schema";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { DbClient } from "../../db/client";
import type {
  MarketplacePreparationApprovalRepository,
  MarketplacePreparationApproveInput,
  MarketplacePreparationRecord,
  MarketplacePreparationRepository,
  MarketplacePreparationUpsertInput,
  SynchronousMarketplacePreparationApprovalRepository,
} from "./types";

/**
 * Sprint 107: the plain, non-transaction-scoped generate/read repository -
 * mirrors services/aiDrafts.ts's own direct `await db.select()/db.insert()`
 * calls exactly (no execution-aware sync/async duality needed; both DbClient
 * drivers are uniformly awaitable outside an explicit db.transaction()
 * callback). Upsert never conflicts: an existing (productId, channel) row is
 * always refreshed in place (status reset to "pending", appliedAt/
 * appliedByAdminUserId cleared) regardless of its prior status - see
 * schema.sqlite.ts's marketplacePreparations comment for why this is safe
 * (approved content lives on Product, never here).
 */
export function createDrizzleMarketplacePreparationRepository(db: DbClient): MarketplacePreparationRepository {
  return {
    async findByProductIdAndChannel(productId, channel) {
      const [row] = await db
        .select()
        .from(marketplacePreparations)
        .where(and(eq(marketplacePreparations.productId, productId), eq(marketplacePreparations.channel, channel)));
      return (row as MarketplacePreparationRecord) ?? null;
    },
    async upsert(input: MarketplacePreparationUpsertInput) {
      const [existing] = await db
        .select()
        .from(marketplacePreparations)
        .where(and(eq(marketplacePreparations.productId, input.productId), eq(marketplacePreparations.channel, input.channel)));

      const now = new Date().toISOString();
      const suggestedFields = {
        suggestedTitle: input.suggestedTitle,
        suggestedDescription: input.suggestedDescription,
        suggestedConditionDescription: input.suggestedConditionDescription,
        suggestedItemSpecifics: input.suggestedItemSpecifics,
        suggestedTags: input.suggestedTags,
        suggestedMaterials: input.suggestedMaterials,
        suggestedStyle: input.suggestedStyle,
        suggestedOccasion: input.suggestedOccasion,
        suggestedShortDescription: input.suggestedShortDescription,
        suggestedSeoTitle: input.suggestedSeoTitle,
        suggestedMetaDescription: input.suggestedMetaDescription,
        suggestedFocusKeyword: input.suggestedFocusKeyword,
      };

      if (existing) {
        const [updated] = await db
          .update(marketplacePreparations)
          .set({
            status: "pending",
            baseProductUpdatedAt: input.baseProductUpdatedAt,
            ...suggestedFields,
            providerName: input.providerName,
            promptVersion: input.promptVersion,
            generatedAt: input.generatedAt,
            appliedAt: null,
            appliedByAdminUserId: null,
            updatedAt: now,
          })
          .where(eq(marketplacePreparations.id, existing.id as string))
          .returning();
        return updated as MarketplacePreparationRecord;
      }

      const [inserted] = await db
        .insert(marketplacePreparations)
        .values({
          id: input.id,
          productId: input.productId,
          channel: input.channel,
          status: "pending",
          baseProductUpdatedAt: input.baseProductUpdatedAt,
          ...suggestedFields,
          providerName: input.providerName,
          promptVersion: input.promptVersion,
          generatedAt: input.generatedAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted as MarketplacePreparationRecord;
    },
  };
}

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
 * Sprint 107: mirrors repositories/ai-draft/drizzle.ts's
 * createDrizzleAiDraftApprovalRepository exactly - one atomic conditional
 * UPDATE ... WHERE id = ? AND status = 'pending' RETURNING ..., decided
 * solely by the returned row count. The diagnostic read below only runs
 * after zero rows changed. Used exclusively inside the approval transaction
 * (services/marketplacePreparationApprovalTransactionCapabilityForDb.ts).
 */
export function createDrizzleMarketplacePreparationApprovalRepository(
  db: any,
  schema: Schema,
  execution: Execution = "asynchronous",
): MarketplacePreparationApprovalRepository | SynchronousMarketplacePreparationApprovalRepository {
  const table = (schema as Record<string, any>).marketplacePreparations;
  return {
    findById(id: string) {
      return then(first(db.select().from(table).where(eq(table.id, id)), execution), (row) => row ?? null) as any;
    },
    claimAndApprove({ id, appliedAt, appliedByAdminUserId, updatedAt }: MarketplacePreparationApproveInput) {
      return then(
        rows(
          db
            .update(table)
            .set({ status: "applied", appliedAt, appliedByAdminUserId, updatedAt })
            .where(and(eq(table.id, id), eq(table.status, "pending")))
            .returning(),
          execution,
        ),
        (changed: any[]) => {
          if (changed.length) return { updated: true, row: changed[0] };
          return then(first(db.select().from(table).where(eq(table.id, id)), execution), (existing: any) => {
            if (!existing) return { updated: false, conflict: { field: "id" as const, message: "Marketplace preparation not found" } };
            return {
              updated: false,
              conflict: { field: "status" as const, message: `Only a Pending marketplace preparation can be approved (current status: "${existing.status}")` },
            };
          });
        },
      ) as any;
    },
  };
}
