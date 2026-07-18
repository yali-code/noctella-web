import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";
import { SalesCompletionCoordinationError, SalesCompletionIdempotencyConflictError } from "../../application/sales/errors";
import type { SalesCompletionCommitInput } from "../../application/sales/completionCoordination";
import type { SalesCompletionTransactionRepository } from "./types";
import { persistedResult, replayResult } from "./shared";
const rows = <T>(query: any): T[] => Array.isArray(query) ? query : query?.all?.() ?? [];
export function createSqliteSalesCompletionTransactionRepository(db: any): SalesCompletionTransactionRepository { return Object.freeze({ commit(input: SalesCompletionCommitInput) {
  const result = persistedResult(input);
  const inserted = rows<any>(db.insert(schema.saleCompletionExecutions).values({ idempotencyKey: input.idempotencyKey, payloadFingerprint: input.payloadFingerprint, saleId: input.snapshot.saleId, resultPayload: JSON.stringify(result), createdAt: input.snapshot.completedAt }).onConflictDoNothing({ target: schema.saleCompletionExecutions.idempotencyKey }).returning());
  if (!inserted.length) { const existing = rows<any>(db.select().from(schema.saleCompletionExecutions).where(eq(schema.saleCompletionExecutions.idempotencyKey, input.idempotencyKey)))[0]; if (existing.payloadFingerprint !== input.payloadFingerprint) throw new SalesCompletionIdempotencyConflictError(input.idempotencyKey); return replayResult(existing.resultPayload); }
  db.insert(schema.saleFinancials).values({ id: input.financialSnapshotId, orderId: input.snapshot.saleId, grossRevenue: input.snapshot.grossRevenue, shippingCharged: input.snapshot.shippingCharged, shippingCost: input.snapshot.shippingCost, marketplaceFee: input.snapshot.marketplaceFee, promotedFee: input.snapshot.promotedFee, paymentFee: input.snapshot.paymentFee, taxVat: input.snapshot.taxVat, itemCost: input.snapshot.itemCost, netRevenue: input.snapshot.netRevenue, profit: input.snapshot.profit, currency: input.snapshot.currency, sourceSnapshot: JSON.stringify(input.snapshot), completedAt: input.snapshot.completedAt, createdAt: input.snapshot.completedAt }).run();
  db.insert(schema.financeEntries).values({ id: input.financeEntryId, orderId: input.snapshot.saleId, entryType: input.financeEntry.entryType, currency: input.financeEntry.currency, amount: input.financeEntry.amount, sourceReference: input.financeEntry.sourceReference, sourceSnapshot: JSON.stringify(input.financeEntry.snapshot), idempotencyKey: input.financeEntry.idempotencyKey, occurredAt: input.financeEntry.occurredAt, createdAt: input.financeEntry.occurredAt }).run();
  if (input.historyEntry && input.completionHistoryId) db.insert(schema.shipmentEvents).values({ id: input.completionHistoryId, shipmentId: input.historyEntry.shipmentId, eventType: input.historyEntry.eventType, payloadSnapshot: JSON.stringify(input.historyEntry.financialSnapshot), createdAt: input.historyEntry.occurredAt }).run();
  const finalized = db.update(schema.orders).set({ status: "Completed", updatedAt: input.finalUpdatedAt }).where(eq(schema.orders.id, input.snapshot.saleId)).run();
  if (finalized.changes !== 1) throw new SalesCompletionCoordinationError("sale_final_state", "not_found");
  return result;
} }); }
