import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { outboxEvents } from "../../db/schema";
import { OutboxEventStatus, OutboxEventType } from "../../domain/outboxContracts";

export function stockSyncIntentKey(mutationKey: string, productId: string) {
  return `stock-sync-intent:${mutationKey}:${productId}`;
}

/** Persist a stock-sync intent using the caller's transaction-scoped database handle. */
export function recordStockSyncIntent(tx: DbClient, productId: string, mutationKey: string): void | Promise<void> {
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
