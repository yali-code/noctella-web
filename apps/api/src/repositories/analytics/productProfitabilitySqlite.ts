import { and, asc, eq, gt, inArray } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";
import type { ProductProfitabilitySource, ProfitabilityPurchaseLineSource, ProfitabilitySaleSource } from "../../use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1B: read-only SQLite repository - SELECT statements only, no writes, no
 * transactions, no derived values. Loads exactly the canonical rows the pure projection
 * (use-cases/analytics/productProfitability.ts) needs for one product. Only completed sales
 * (orders with a sale_financials row) are loaded as sale attempts.
 */
export function createSqliteProductProfitabilityReadRepository(db: any) {
  return Object.freeze({
    loadSource(productId: string): ProductProfitabilitySource | null {
      const row = db
        .select({ p: schema.products, noctellaId: schema.productErpMetadata.noctellaId, categoryName: schema.categories.name })
        .from(schema.products)
        .leftJoin(schema.productErpMetadata, eq(schema.productErpMetadata.productId, schema.products.id))
        .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
        .where(eq(schema.products.id, productId))
        .get();
      if (!row) return null;
      const p = row.p;

      const lineRows: any[] = db
        .select({ line: schema.purchaseLines, purchase: schema.purchases })
        .from(schema.purchaseLines)
        .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
        .where(eq(schema.purchaseLines.productId, productId))
        .all();
      const purchaseLines: ProfitabilityPurchaseLineSource[] = lineRows.map(({ line, purchase }) => {
        const allocation = db.select().from(schema.purchaseAllocations).where(eq(schema.purchaseAllocations.purchaseLineId, line.id)).get();
        const receipt = db
          .select({ receivedAt: schema.purchaseReceipts.receivedAt })
          .from(schema.purchaseReceiptLines)
          .innerJoin(schema.purchaseReceipts, eq(schema.purchaseReceipts.id, schema.purchaseReceiptLines.receiptId))
          .where(and(eq(schema.purchaseReceiptLines.purchaseLineId, line.id), gt(schema.purchaseReceiptLines.quantityReceived, 0)))
          .orderBy(asc(schema.purchaseReceipts.receivedAt))
          .get();
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
          firstReceiptAt: receipt?.receivedAt ?? null,
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

      const orderIds = [...new Set((db.select({ orderId: schema.orderItems.orderId }).from(schema.orderItems).where(eq(schema.orderItems.productId, productId)).all() as any[]).map((r) => r.orderId as string))];
      const financials: any[] = orderIds.length ? db.select().from(schema.saleFinancials).where(inArray(schema.saleFinancials.orderId, orderIds)).all() : [];
      const sales: ProfitabilitySaleSource[] = financials
        .map((sf) => {
          const order = db.select().from(schema.orders).where(eq(schema.orders.id, sf.orderId)).get();
          const marketplaceOrder = db.select().from(schema.marketplaceOrders).where(eq(schema.marketplaceOrders.internalOrderId, sf.orderId)).get();
          const returns = (db.select().from(schema.returnRequests).where(eq(schema.returnRequests.orderId, sf.orderId)).all() as any[]).map((r) => ({
            status: r.status,
            items: (db.select().from(schema.returnItems).where(eq(schema.returnItems.returnRequestId, r.id)).all() as any[]).map((item) => ({
              orderItemId: item.orderItemId,
              stockDisposition: item.stockDisposition,
              quantityCompleted: item.quantityCompleted,
            })),
          }));
          const reversal = db
            .select({ id: schema.saleReversals.id })
            .from(schema.saleReversals)
            .where(and(eq(schema.saleReversals.orderId, sf.orderId), eq(schema.saleReversals.financialsReversed, true)))
            .get();
          return {
            orderId: sf.orderId,
            orderDraftId: order?.orderDraftId ?? null,
            orderCurrency: order?.currency ?? sf.currency,
            orderCreatedAt: order?.createdAt ?? sf.completedAt,
            marketplaceChannel: marketplaceOrder?.channel ?? null,
            marketplaceOrderedAt: marketplaceOrder?.orderedAt ?? null,
            lines: (db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, sf.orderId)).all() as any[]).map((l) => ({ orderItemId: l.id, productId: l.productId, quantity: l.quantity })),
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
            payments: (db.select().from(schema.payments).where(eq(schema.payments.orderId, sf.orderId)).all() as any[]).map((pay) => ({ status: pay.status, amount: pay.amount, currency: pay.currency })),
            shipments: (db.select().from(schema.shipments).where(eq(schema.shipments.orderId, sf.orderId)).all() as any[]).map((s) => ({ status: s.status, shippingCost: s.shippingCost, currency: s.currency })),
            refunds: (db.select().from(schema.refunds).where(eq(schema.refunds.orderId, sf.orderId)).all() as any[]).map((r) => ({
              status: r.status,
              currency: r.currency,
              subtotalAmount: r.subtotalAmount,
              shippingAmount: r.shippingAmount,
              taxAmount: r.taxAmount,
              totalAmount: r.totalAmount,
              marketplaceFeeAdjustment: r.marketplaceFeeAdjustment,
              paymentFeeAdjustment: r.paymentFeeAdjustment,
            })),
            returns,
            fullReversal: !!reversal,
          };
        })
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
    },
  });
}
