import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { MarketingTagRecord } from "./types";

/**
 * Sprint 148: a narrow, transaction-scoped, dual sync/async Marketing Tag write repository - used
 * exclusively inside canonicalProductProposalApprovalTransactionCapabilityForDb.ts's Accept
 * transaction, so canonical Product field mutation and additive Marketing Tags can be applied as
 * one atomic operation (Architecture Review requirement L). The existing plain
 * repositories/marketing-tags/drizzle.ts (createDrizzleMarketingTagRepository) is always-async
 * (plain `await db.select()/...`), which is incompatible with the SQLite driver's synchronous
 * `db.transaction()` callback contract (better-sqlite3 transaction callbacks must never return a
 * Promise - see marketplacePreparationApprovalTransactionCapabilityForDb.ts's identical
 * constraint). This mirrors createDrizzleCanonicalProductProposalApprovalRepository's exact
 * `rows`/`first`/`then` sync/async duality pattern instead of introducing a new one. Only the two
 * operations Accept actually needs - findOrCreateByKey and an idempotent addRelation - the
 * existing Admin-facing marketing tag surface (services/marketingTags.ts, its route, and its own
 * repository) is completely untouched.
 */
export interface TransactionalMarketingTagWriteRepository {
  findOrCreateByKey(key: string, label: string): MarketingTagRecord | Promise<MarketingTagRecord>;
  /** Idempotent - inserting an already-existing (productId, marketingTagId) relation is a safe no-op. */
  addRelation(productId: string, marketingTagId: string): void | Promise<void>;
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

export function createDrizzleTransactionalMarketingTagWriteRepository(
  db: any,
  schema: Schema,
  execution: Execution = "asynchronous",
): TransactionalMarketingTagWriteRepository {
  const tagsTable = (schema as Record<string, any>).marketingTags;
  const relationsTable = (schema as Record<string, any>).productMarketingTags;
  return {
    findOrCreateByKey(key: string, label: string) {
      return then(first(db.select().from(tagsTable).where(eq(tagsTable.key, key)), execution), (existing: any) => {
        if (existing) return existing as MarketingTagRecord;
        const now = new Date().toISOString();
        const id = randomUUID();
        return then(
          rows(db.insert(tagsTable).values({ id, key, label, createdAt: now, updatedAt: now }).returning(), execution),
          (inserted: any[]) => inserted[0] as MarketingTagRecord,
        );
      }) as any;
    },
    addRelation(productId: string, marketingTagId: string) {
      return then(
        first(db.select().from(relationsTable).where(and(eq(relationsTable.productId, productId), eq(relationsTable.marketingTagId, marketingTagId))), execution),
        (existing: any) => {
          if (existing) return undefined;
          const id = randomUUID();
          return then(
            rows(db.insert(relationsTable).values({ id, productId, marketingTagId, createdAt: new Date().toISOString() }).returning(), execution),
            () => undefined,
          );
        },
      ) as any;
    },
  };
}
