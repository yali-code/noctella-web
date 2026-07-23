import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { RefundStatus, ReturnStatus, ReturnStockDisposition } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { orderItems, refunds, returnItems, returnRequests, saleFinancials, saleReversals } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { createFinanceEntrySync } from "./financePostings";
import { sanitizeError } from "./backgroundJobs";
import { calculateMaximumRefund } from "./refundsCompatibility";
import { setRefundServiceAdapterResolver } from "./refundServiceContext";
export function setReturnMarketplaceAdapterResolver(resolver?: Parameters<typeof setRefundServiceAdapterResolver>[0]) { setRefundServiceAdapterResolver(resolver); }
const now = () => new Date().toISOString();
export { calculateMaximumRefund, validateRefundAmount, createRefund, getRefund, listRefunds, submitRefund, cancelRefund, retryRefund, executeMarketplaceRefund } from "./refundsCompatibility";
export async function getSaleReversalReadiness(db: DbClient, orderId: string) { const max = await calculateMaximumRefund(db, orderId); const completedReturns = await db.select().from(returnRequests).where(and(eq(returnRequests.orderId, orderId), eq(returnRequests.status, ReturnStatus.Completed))); const purchased = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)); let returnedQty = 0; for (const ret of completedReturns) { const its = await db.select().from(returnItems).where(eq(returnItems.returnRequestId, ret.id)); returnedQty += its.reduce((sum, item) => sum + Math.min(item.quantityApproved ?? item.quantityReceived ?? 0, item.quantityReceived ?? item.quantityRequested), 0); } const purchasedQty = purchased.reduce((sum, item) => sum + item.quantity, 0); const fullReturn = purchasedQty > 0 && returnedQty >= purchasedQty; return { ready: fullReturn && max.refundableAmount === 0, reasons: !fullReturn ? ["Full approved return is required"] : max.refundableAmount !== 0 ? ["Full refund is required"] : [], allowedActions: ["reverse"] }; }
/** Sprint 52B: identity/meaning fields for a sale reversal request - the same fields reverseCompletedSale reads off `input` and persists onto the row. Used to detect an idempotency key reused with a semantically different request. */
function sameSaleReversalPayload(existing: any, input: any) { return existing.orderId === input.orderId && (existing.returnRequestId ?? null) === (input.returnRequestId ?? null) && (existing.refundId ?? null) === (input.refundId ?? null); }
export async function reverseCompletedSale(db: DbClient, input: any) {
  const key = input.idempotencyKey ?? `sale-reversal:${input.orderId}`;
  const [existing] = await db.select().from(saleReversals).where(eq(saleReversals.idempotencyKey, key));
  if (existing) {
    if (!sameSaleReversalPayload(existing, input)) throw new ConflictError("Idempotency key was already used for a different sale reversal");
    return existing;
  }
  const readiness = await getSaleReversalReadiness(db, input.orderId);
  if (!readiness.ready) throw new BadRequestError(readiness.reasons.join("; "));
  const [sf] = await db.select().from(saleFinancials).where(eq(saleFinancials.orderId, input.orderId));
  const row = { id: randomUUID(), orderId: input.orderId, returnRequestId: input.returnRequestId, refundId: input.refundId, reversalType: "full", stockReversed: true, financialsReversed: true, originalSaleFinancialId: sf?.id, sourceSnapshot: JSON.stringify({ saleFinancial: sf ?? null, requested: input }), idempotencyKey: key, createdAt: now() };
  // Sprint 52B: the sale_reversals insert and its finance entry must commit or roll back
  // together - previously these were two separate non-transactional writes, so a crash
  // between them could leave an orphaned reversal with no corresponding finance entry.
  const transaction = (db as any).transaction((tx: any) => {
    tx.insert(saleReversals).values(row).run();
    createFinanceEntrySync(tx, { orderId: row.orderId, refundId: row.refundId, saleReversalId: row.id, entryType: "SaleReversal", amount: 0, sourceReference: row.id, idempotencyKey: `sale-reversal:${row.id}`, snapshot: row });
  });
  if (typeof transaction === "function") (transaction as () => void)();
  return row;
}
export async function getReturnFinancialSummary(db: DbClient, orderId: string) { const [sf] = await db.select().from(saleFinancials).where(eq(saleFinancials.orderId, orderId)); const [{ subtotal, shipping, tax, total }] = await db.select({ subtotal: sql<number>`coalesce(sum(${refunds.subtotalAmount}),0)`, shipping: sql<number>`coalesce(sum(${refunds.shippingAmount}),0)`, tax: sql<number>`coalesce(sum(${refunds.taxAmount}),0)`, total: sql<number>`coalesce(sum(${refunds.totalAmount}),0)` }).from(refunds).where(and(eq(refunds.orderId, orderId), eq(refunds.status, RefundStatus.Succeeded))); const completedReturns = await db.select().from(returnRequests).where(and(eq(returnRequests.orderId, orderId), eq(returnRequests.status, ReturnStatus.Completed))); let returnedItemCost = 0; for (const ret of completedReturns) { const its = await db.select().from(returnItems).where(eq(returnItems.returnRequestId, ret.id)); for (const item of its) returnedItemCost += item.stockDisposition === ReturnStockDisposition.ReturnToStock ? 0 : 0; } const feeKnown = sf ? sf.marketplaceFee !== null && sf.paymentFee !== null : false; return { orderId, originalGrossRevenue: sf?.grossRevenue ?? 0, refundedSubtotal: subtotal, refundedShipping: shipping, refundedTax: tax, marketplaceFeeAdjustment: null, paymentFeeAdjustment: null, totalRefunded: total, netRetainedRevenue: (sf?.grossRevenue ?? 0) - total, returnedItemCost, stockDispositionWriteOffValue: null, adjustedProfit: sf && feeKnown ? sf.profit - total : undefined, adjustedProfitComplete: !!sf && feeKnown }; }
const clean=(e:unknown)=>String((e as any)?.message??e).replace(/Bearer\s+\S+|access_token\S*|refresh_token\S*/gi,"[redacted]");
export function normalizeReturnError(error: unknown) { const safe = sanitizeError(error); return { type: safe.type, message: clean(error), retryable: safe.retryable }; }
