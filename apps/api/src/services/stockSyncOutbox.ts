import type { DbClient } from "../db/client";
import { recordStockSyncIntent, stockSyncIntentKey } from "../repositories/inventory/stockSyncIntentWriter";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType, type OutboxEvent, type OutboxHandler } from "./outbox";
import { PostgresOutboxRepository, SqliteOutboxRepository } from "./outboxRepository";
import { enqueueProductStockSync } from "./stockSync";

/** Works in both synchronous SQLite and async Postgres transaction callbacks. */
export function enqueueStockSyncIntent(tx: DbClient, productId: string, mutationKey: string): void | Promise<void> {
  return recordStockSyncIntent(tx, productId, mutationKey);
}

export { stockSyncIntentKey };

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
