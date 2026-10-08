import { and, eq, gt, inArray } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";
import type { ProductProfitabilitySource, ProfitabilityPurchaseLineSource, ProfitabilitySaleSource } from "../../use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1B: read-only SQLite repository - SELECT statements only, no writes, no
 * transactions, no derived values. Loads exactly the canonical rows the pure projection
 * (use-cases/analytics/productProfitability.ts) needs. Only completed sales (orders with a
 * sale_financials row) are loaded as sale attempts.
 *
 * Phase 1D: batch-first - loadSources runs one bounded query per table (chunked IN lists) and
 * assembles every product's source in memory, so a catalogue evaluation is not N+1. loadSource
 * is the single-product view of the same code path; there is exactly one mapping implementation.
 */
const IN_CHUNK = 500;

function inChunks<T>(db: any, ids: readonly string[], query: (chunk: string[]) => any): T[] {
  const unique = [...new Set(ids)];
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) rows.push(...(query(unique.slice(i, i + IN_CHUNK)).all() as T[]));
  return rows;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export function createSqliteProductProfitabilityReadRepository(db: any) {
  /** All products when `productIds` is omitted; otherwise only the given ids (unknown ids are skipped). */
  function loadSources(productIds?: readonly string[]): ProductProfitabilitySource[] {
    const productQuery = (where?: any) =>
      db
        .select({ p: schema.products, noctellaId: schema.productErpMetadata.noctellaId, categoryName: schema.categories.name })
        .from(schema.products)
        .leftJoin(schema.productErpMetadata, eq(schema.productErpMetadata.productId, schema.products.id))
        .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
        .where(where);
    const productRows: any[] = productIds ? inChunks(db, productIds, (chunk) => productQuery(inArray(schema.products.id, chunk))) : productQuery().all();
    if (productRows.length === 0) return [];
    const ids = productRows.map((row) => row.p.id as string);

    // Purchasing: lines (+ purchase header), allocations, and first positive receipt per line.
    const lineRows = inChunks<any>(db, ids, (chunk) =>
      db.select({ line: schema.purchaseLines, purchase: schema.purchases }).from(schema.purchaseLines).innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId)).where(inArray(schema.purchaseLines.productId, chunk)),
    );
    const lineIds = lineRows.map((row) => row.line.id as string);
    const allocationByLine = new Map<string, any>();
    for (const allocation of inChunks<any>(db, lineIds, (chunk) => db.select().from(schema.purchaseAllocations).where(inArray(schema.purchaseAllocations.purchaseLineId, chunk)))) {
      if (!allocationByLine.has(allocation.purchaseLineId)) allocationByLine.set(allocation.purchaseLineId, allocation);
    }
    const firstReceiptByLine = new Map<string, string>();
    for (const receipt of inChunks<any>(db, lineIds, (chunk) =>
      db
        .select({ purchaseLineId: schema.purchaseReceiptLines.purchaseLineId, receivedAt: schema.purchaseReceipts.receivedAt })
        .from(schema.purchaseReceiptLines)
        .innerJoin(schema.purchaseReceipts, eq(schema.purchaseReceipts.id, schema.purchaseReceiptLines.receiptId))
        .where(and(inArray(schema.purchaseReceiptLines.purchaseLineId, chunk), gt(schema.purchaseReceiptLines.quantityReceived, 0))),
    )) {
      const current = firstReceiptByLine.get(receipt.purchaseLineId);
      if (current === undefined || receipt.receivedAt < current) firstReceiptByLine.set(receipt.purchaseLineId, receipt.receivedAt);
    }
    const linesByProduct = groupBy(lineRows, (row) => row.line.productId);

    // Sales: only orders containing these products that have a sale_financials row.
    const productItemRows = inChunks<any>(db, ids, (chunk) => db.select({ orderId: schema.orderItems.orderId, productId: schema.orderItems.productId }).from(schema.orderItems).where(inArray(schema.orderItems.productId, chunk)));
    const financials = inChunks<any>(db, productItemRows.map((row) => row.orderId), (chunk) => db.select().from(schema.saleFinancials).where(inArray(schema.saleFinancials.orderId, chunk)));
    const orderIds = financials.map((sf) => sf.orderId as string);
    const byOrder = <T>(rows: T[], key: (row: T) => string) => groupBy(rows, key);
    const orders = new Map(inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.orders).where(inArray(schema.orders.id, chunk))).map((o) => [o.id, o]));
    const marketplaceOrders = new Map<string, any>();
    for (const mo of inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.marketplaceOrders).where(inArray(schema.marketplaceOrders.internalOrderId, chunk)))) {
      if (!marketplaceOrders.has(mo.internalOrderId)) marketplaceOrders.set(mo.internalOrderId, mo);
    }
    const linesByOrder = byOrder(inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, chunk))), (l) => l.orderId);
    const paymentsByOrder = byOrder(inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.payments).where(inArray(schema.payments.orderId, chunk))), (p) => p.orderId);
    const shipmentsByOrder = byOrder(inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.shipments).where(inArray(schema.shipments.orderId, chunk))), (s) => s.orderId);
    const refundsByOrder = byOrder(inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.refunds).where(inArray(schema.refunds.orderId, chunk))), (r) => r.orderId);
    const returnRows = inChunks<any>(db, orderIds, (chunk) => db.select().from(schema.returnRequests).where(inArray(schema.returnRequests.orderId, chunk)));
    const returnsByOrder = byOrder(returnRows, (r) => r.orderId);
    const returnItemsByReturn = groupBy(inChunks<any>(db, returnRows.map((r) => r.id), (chunk) => db.select().from(schema.returnItems).where(inArray(schema.returnItems.returnRequestId, chunk))), (item) => item.returnRequestId);
    const reversedOrders = new Set(
      inChunks<any>(db, orderIds, (chunk) => db.select({ orderId: schema.saleReversals.orderId }).from(schema.saleReversals).where(and(inArray(schema.saleReversals.orderId, chunk), eq(schema.saleReversals.financialsReversed, true)))).map((r) => r.orderId),
    );

    const saleByOrder = new Map<string, ProfitabilitySaleSource>(
      financials.map((sf) => {
        const order = orders.get(sf.orderId);
        const marketplaceOrder = marketplaceOrders.get(sf.orderId);
        return [
          sf.orderId,
          {
            orderId: sf.orderId,
            orderDraftId: order?.orderDraftId ?? null,
            orderCurrency: order?.currency ?? sf.currency,
            orderCreatedAt: order?.createdAt ?? sf.completedAt,
            marketplaceChannel: marketplaceOrder?.channel ?? null,
            marketplaceOrderedAt: marketplaceOrder?.orderedAt ?? null,
            lines: (linesByOrder.get(sf.orderId) ?? []).map((l) => ({ orderItemId: l.id, productId: l.productId, quantity: l.quantity })),
            saleFinancials: {
              grossRevenue: sf.grossRevenue,
              shippingCharged: sf.shippingCharged,
              shippingCost: sf.shippingCost,
              marketplaceFee: sf.marketplaceFee,
              promotedFee: sf.promotedFee,
              paymentFee: sf.paymentFee,
              taxVat: sf.taxVat,
              itemCost: sf.itemCost,
              netRevenue: sf.netRevenue,
              profit: sf.profit,
              currency: sf.currency,
              completedAt: sf.completedAt,
            },
            payments: (paymentsByOrder.get(sf.orderId) ?? []).map((pay) => ({ status: pay.status, amount: pay.amount, currency: pay.currency })),
            shipments: (shipmentsByOrder.get(sf.orderId) ?? []).map((s) => ({ status: s.status, shippingCost: s.shippingCost, currency: s.currency, carrierCode: s.carrierCode })),
            refunds: (refundsByOrder.get(sf.orderId) ?? []).map((r) => ({
              status: r.status,
              currency: r.currency,
              subtotalAmount: r.subtotalAmount,
              shippingAmount: r.shippingAmount,
              taxAmount: r.taxAmount,
              totalAmount: r.totalAmount,
              marketplaceFeeAdjustment: r.marketplaceFeeAdjustment,
              paymentFeeAdjustment: r.paymentFeeAdjustment,
            })),
            returns: (returnsByOrder.get(sf.orderId) ?? []).map((r) => ({
              status: r.status,
              items: (returnItemsByReturn.get(r.id) ?? []).map((item) => ({ orderItemId: item.orderItemId, stockDisposition: item.stockDisposition, quantityCompleted: item.quantityCompleted })),
            })),
            fullReversal: reversedOrders.has(sf.orderId),
          },
        ];
      }),
    );
    const orderIdsByProduct = groupBy(productItemRows, (row) => row.productId);

    return productRows.map((row) => {
      const p = row.p;
      const purchaseLines: ProfitabilityPurchaseLineSource[] = (linesByProduct.get(p.id) ?? []).map(({ line, purchase }) => {
        const allocation = allocationByLine.get(line.id);
        return {
          purchaseLineId: line.id,
          purchaseId: purchase.id,
          purchaseStatus: purchase.status,
          purchaseCurrency: purchase.currency,
          purchaseTotalCost: purchase.totalCost,
          quantity: line.quantity,
          unitPurchaseCost: line.unitPurchaseCost,
          orderedAt: purchase.orderedAt,
          purchaseReceivedAt: purchase.receivedAt,
          firstReceiptAt: firstReceiptByLine.get(line.id) ?? null,
          allocation: allocation
            ? {
                allocatedBuyerPremium: allocation.allocatedBuyerPremium,
                allocatedShippingCost: allocation.allocatedShippingCost,
                allocatedCustomsCost: allocation.allocatedCustomsCost,
                allocatedPackagingCost: allocation.allocatedPackagingCost,
                allocatedTaxVat: allocation.allocatedTaxVat,
                allocatedMiscCost: allocation.allocatedMiscCost,
                allocatedTotalCost: allocation.allocatedTotalCost,
              }
            : null,
        };
      });
      const sales = [...new Set((orderIdsByProduct.get(p.id) ?? []).map((r) => r.orderId as string))]
        .map((orderId) => saleByOrder.get(orderId))
        .filter((sale): sale is ProfitabilitySaleSource => sale !== undefined)
        .sort((a, b) => a.saleFinancials.completedAt.localeCompare(b.saleFinancials.completedAt));
      return {
        product: {
          id: p.id,
          sku: p.sku,
          title: p.title,
          status: p.status,
          brand: p.brand,
          categoryName: row.categoryName ?? null,
          noctellaId: row.noctellaId ?? null,
          stockQuantity: p.stockQuantity,
          purchaseCost: p.purchaseCost,
          purchaseCurrency: p.purchaseCurrency,
          createdAt: p.createdAt,
        },
        purchaseLines,
        sales,
      };
    });
  }

  return Object.freeze({
    loadSources,
    loadSource(productId: string): ProductProfitabilitySource | null {
      return loadSources([productId])[0] ?? null;
    },
  });
}
