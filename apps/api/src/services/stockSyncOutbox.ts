import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { outboxEvents } from "../db/schema";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType, type OutboxEvent, type OutboxHandler } from "./outbox";
import { PostgresOutboxRepository, SqliteOutboxRepository } from "./outboxRepository";
import { enqueueProductStockSync } from "./stockSync";

export function stockSyncIntentKey(mutationKey: string, productId: string) {
  return `stock-sync-intent:${mutationKey}:${productId}`;
}

/** Works in both synchronous SQLite and async Postgres transaction callbacks. */
export function enqueueStockSyncIntent(tx: DbClient, productId: string, mutationKey: string): void | Promise<void> {
  const key = stockSyncIntentKey(mutationKey, productId);
  const query: any = tx.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, key)).limit(1);
  const insert = () => {
    const now = new Date().toISOString();
    const statement: any = tx.insert(outboxEvents).values({
      id: randomUUID(), eventType: OutboxEventType.StockSyncRequested, aggregateType: "Product", aggregateId: productId,
      idempotencyKey: key, payload: JSON.stringify({ productId, mutationKey }), status: OutboxEventStatus.Pending,
      attemptCount: 0, maxAttempts: 5, availableAt: now, createdAt: now, updatedAt: now,
    });
    if (typeof statement.run === "function") { statement.run(); return; }
    return Promise.resolve(statement).then(() => undefined);
  };
  if (typeof query.get === "function") return query.get() ? undefined : insert();
  return Promise.resolve(query).then((rows: unknown[]) => rows.length ? undefined : insert()).then(() => undefined);
}

export class MaterializeStockSyncJobsHandler implements OutboxHandler {
  eventType = OutboxEventType.StockSyncRequested;
  constructor(private readonly db: DbClient) {}
  async handle(event: OutboxEvent) {
    const productId = String(event.payload.productId ?? event.aggregateId ?? "");
    if (!productId) throw Object.assign(new Error("Stock-sync intent has no Product"), { permanent: true, code: "STOCK_SYNC_INTENT_INVALID" });
    await enqueueProductStockSync(this.db, productId, event.idempotencyKey);
  }
}

export function createStockSyncOutboxDispatcher(db: DbClient, driver: "sqlite" | "postgres" | "supabase-postgres" = (process.env.DATABASE_DRIVER as any) || "sqlite") {
  const repo = driver === "sqlite"
    ? new SqliteOutboxRepository((db as any).$client)
    : new PostgresOutboxRepository((db as any).$client);
  const dispatcher = new OutboxDispatcher(repo);
  dispatcher.registerHandler(new MaterializeStockSyncJobsHandler(db));
  return dispatcher;
}

export async function dispatchDueStockSyncOutboxEvents(db: DbClient, workerId = "scheduler", limit = 10) {
  const dispatcher = createStockSyncOutboxDispatcher(db);
  await dispatcher.releaseStaleLocks(5 * 60 * 1000);
  return dispatcher.dispatchDueEvents(workerId, limit);
}
