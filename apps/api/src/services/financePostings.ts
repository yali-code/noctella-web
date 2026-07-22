import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { financeEntries } from "../db/schema";
const now = () => new Date().toISOString();
const money = (n: number) => Number(n.toFixed(2));
export async function createFinanceEntry(db: DbClient, input: any) {
  const [existing] = await db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return existing;
  const row = { id: randomUUID(), orderId: input.orderId ?? null, invoiceId: input.invoiceId ?? null, refundId: input.refundId ?? null, saleReversalId: input.saleReversalId ?? null, entryType: input.entryType, currency: "EUR", amount: money(Number(input.amount ?? 0)), sourceReference: input.sourceReference, sourceSnapshot: JSON.stringify(input.snapshot ?? {}), idempotencyKey: input.idempotencyKey, occurredAt: input.occurredAt ?? now(), createdAt: now() };
  await db.insert(financeEntries).values(row);
  return row;
}

/**
 * Synchronous sibling of createFinanceEntry, for use only inside a
 * synchronous better-sqlite3 db.transaction() callback (drizzle's async
 * query methods cannot be awaited there). Same field mapping and
 * idempotency-key check-then-insert behavior as the async version.
 */
export function createFinanceEntrySync(db: DbClient, input: any) {
  const existing = db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, input.idempotencyKey)).limit(1).get();
  if (existing) return existing;
  const row = { id: randomUUID(), orderId: input.orderId ?? null, invoiceId: input.invoiceId ?? null, refundId: input.refundId ?? null, saleReversalId: input.saleReversalId ?? null, entryType: input.entryType, currency: "EUR", amount: money(Number(input.amount ?? 0)), sourceReference: input.sourceReference, sourceSnapshot: JSON.stringify(input.snapshot ?? {}), idempotencyKey: input.idempotencyKey, occurredAt: input.occurredAt ?? now(), createdAt: now() };
  db.insert(financeEntries).values(row).run();
  return row;
}
