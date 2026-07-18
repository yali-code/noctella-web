import { and, eq } from "drizzle-orm";
import * as schema from "../../db/schema.postgres";
import { SaleConcurrencyConflictError, SalesCompletionIdempotencyConflictError } from "../../application/sales/errors";
import type { SalesCompletionCommitInput } from "../../application/sales/completionCoordination";
import type { SalesCompletionTransactionRepository } from "./types";
import { persistedResult, replayResult } from "./shared";
export function createPostgresSalesCompletionTransactionRepository(db: any): SalesCompletionTransactionRepository { return Object.freeze({ async commit(input: SalesCompletionCommitInput) {
  const result = persistedResult(input);
  const inserted = await db.insert(schema.saleCompletionExecutions).values({ idempotencyKey: input.idempotencyKey, payloadFingerprint: input.payloadFingerprint, saleId: input.snapshot.saleId, resultPayload: result, createdAt: new Date(input.snapshot.completedAt) }).onConflictDoNothing({ target: schema.saleCompletionExecutions.idempotencyKey }).returning();
  if (!inserted.length) { const [existing] = await db.select().from(schema.saleCompletionExecutions).where(eq(schema.saleCompletionExecutions.idempotencyKey, input.idempotencyKey)); if (existing.payloadFingerprint !== input.payloadFingerprint) throw new SalesCompletionIdempotencyConflictError(input.idempotencyKey); return replayResult(JSON.stringify(existing.resultPayload)); }
  const finalized = await db.update(schema.orders).set({ status: "Completed", updatedAt: new Date(input.finalUpdatedAt) }).where(and(eq(schema.orders.id, input.snapshot.saleId), eq(schema.orders.updatedAt, new Date(input.expectedVersion)))).returning({ id: schema.orders.id });
  if (finalized.length !== 1) throw new SaleConcurrencyConflictError();
  await db.insert(schema.saleFinancials).values({ id: input.financialSnapshotId, orderId: input.snapshot.saleId, grossRevenue: input.snapshot.grossRevenue, shippingCharged: input.snapshot.shippingCharged, shippingCost: input.snapshot.shippingCost, marketplaceFee: input.snapshot.marketplaceFee, promotedFee: input.snapshot.promotedFee, paymentFee: input.snapshot.paymentFee, taxVat: input.snapshot.taxVat, itemCost: input.snapshot.itemCost, netRevenue: input.snapshot.netRevenue, profit: input.snapshot.profit, currency: input.snapshot.currency, sourceSnapshot: input.snapshot, completedAt: new Date(input.snapshot.completedAt), createdAt: new Date(input.snapshot.completedAt) });
  await db.insert(schema.financeEntries).values({ id: input.financeEntryId, orderId: input.snapshot.saleId, entryType: input.financeEntry.entryType, currency: input.financeEntry.currency, amount: input.financeEntry.amount, sourceReference: input.financeEntry.sourceReference, sourceSnapshot: input.financeEntry.snapshot, idempotencyKey: input.financeEntry.idempotencyKey, occurredAt: new Date(input.financeEntry.occurredAt), createdAt: new Date(input.financeEntry.occurredAt) });
  if (input.historyEntry && input.completionHistoryId) await db.insert(schema.shipmentEvents).values({ id: input.completionHistoryId, shipmentId: input.historyEntry.shipmentId, eventType: input.historyEntry.eventType, payloadSnapshot: input.historyEntry.financialSnapshot, createdAt: new Date(input.historyEntry.occurredAt) });
  return result;
} }); }
