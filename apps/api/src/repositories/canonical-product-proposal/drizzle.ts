import { and, eq } from "drizzle-orm";
import { canonicalProductAiProposals } from "../../db/schema";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { DbClient } from "../../db/client";
import type {
  CanonicalProductProposalApprovalRepository,
  CanonicalProductProposalApproveInput,
  CanonicalProductProposalRecord,
  CanonicalProductProposalRepository,
  CanonicalProductProposalUpsertInput,
  SynchronousCanonicalProductProposalApprovalRepository,
} from "./types";

/**
 * Sprint 148: the plain, non-transaction-scoped generate/read repository - mirrors
 * repositories/marketplace-preparation/drizzle.ts's createDrizzleMarketplacePreparationRepository
 * exactly. Upsert never conflicts: an existing productId row is always refreshed in place (status
 * reset to "pending", appliedAt/appliedByAdminUserId cleared, a fresh updatedAt) regardless of its
 * prior status.
 */
export function createDrizzleCanonicalProductProposalRepository(db: DbClient): CanonicalProductProposalRepository {
  return {
    async findByProductId(productId) {
      const [row] = await db.select().from(canonicalProductAiProposals).where(eq(canonicalProductAiProposals.productId, productId));
      return (row as CanonicalProductProposalRecord) ?? null;
    },
    async upsert(input: CanonicalProductProposalUpsertInput) {
      const [existing] = await db.select().from(canonicalProductAiProposals).where(eq(canonicalProductAiProposals.productId, input.productId));

      const now = new Date().toISOString();
      const suggestedFields = {
        suggestedBrand: input.suggestedBrand,
        suggestedModel: input.suggestedModel,
        suggestedManufacturer: input.suggestedManufacturer,
        suggestedCountryOfOrigin: input.suggestedCountryOfOrigin,
        suggestedPeriod: input.suggestedPeriod,
        suggestedMaterials: input.suggestedMaterials,
        suggestedDescription: input.suggestedDescription,
        suggestedProductStory: input.suggestedProductStory,
        suggestedCondition: input.suggestedCondition,
        suggestedConditionDescription: input.suggestedConditionDescription,
        suggestedLengthValue: input.suggestedLengthValue,
        suggestedWidthValue: input.suggestedWidthValue,
        suggestedHeightValue: input.suggestedHeightValue,
        suggestedDimensionUnit: input.suggestedDimensionUnit,
        suggestedWeightValue: input.suggestedWeightValue,
        suggestedWeightUnit: input.suggestedWeightUnit,
        suggestedMarketingTags: input.suggestedMarketingTags,
      };

      if (existing) {
        const [updated] = await db
          .update(canonicalProductAiProposals)
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
          .where(eq(canonicalProductAiProposals.id, existing.id as string))
          .returning();
        return updated as CanonicalProductProposalRecord;
      }

      const [inserted] = await db
        .insert(canonicalProductAiProposals)
        .values({
          id: input.id,
          productId: input.productId,
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
      return inserted as CanonicalProductProposalRecord;
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
 * Sprint 148: mirrors repositories/marketplace-preparation/drizzle.ts's
 * createDrizzleMarketplacePreparationApprovalRepository exactly - one atomic conditional
 * UPDATE ... WHERE id = ? AND status = 'pending' RETURNING ..., decided solely by the returned row
 * count. Used exclusively inside the Accept transaction (services/canonicalProductProposalApprovalTransactionCapabilityForDb.ts).
 */
export function createDrizzleCanonicalProductProposalApprovalRepository(
  db: any,
  schema: Schema,
  execution: Execution = "asynchronous",
): CanonicalProductProposalApprovalRepository | SynchronousCanonicalProductProposalApprovalRepository {
  const table = (schema as Record<string, any>).canonicalProductAiProposals;
  return {
    findById(id: string) {
      return then(first(db.select().from(table).where(eq(table.id, id)), execution), (row) => row ?? null) as any;
    },
    claimAndApply({ id, appliedAt, appliedByAdminUserId, updatedAt }: CanonicalProductProposalApproveInput) {
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
            if (!existing) return { updated: false, conflict: { field: "id" as const, message: "Canonical product proposal not found" } };
            return {
              updated: false,
              conflict: { field: "status" as const, message: `Only a Pending canonical product proposal can be accepted (current status: "${existing.status}")` },
            };
          });
        },
      ) as any;
    },
  };
}
