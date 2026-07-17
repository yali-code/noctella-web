import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { BackgroundJobType, PublishChannel } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { marketplaceConnections, marketplaceOrders, orderItems, orders, returnItems, returnRequests } from "../db/schema";
import { createRefundRepositoriesForDb } from "../repositories/refund/factory";
import { createRefundApplicationContext } from "./refundApplicationContext";
import { SqliteUnitOfWork } from "./unitOfWork";
import { enqueueJob, sanitizeError } from "./backgroundJobs";
import { getMarketplaceAdapter, type MarketplaceAdapter } from "./marketplaceAdapters";
import { decryptCredential } from "./credentialEncryption";

type AdapterResolver = (channel: PublishChannel | string) => MarketplaceAdapter;
let adapterResolver: AdapterResolver = (channel) => getMarketplaceAdapter(channel as PublishChannel);
export function setRefundServiceAdapterResolver(resolver?: AdapterResolver) { adapterResolver = resolver ?? ((channel) => getMarketplaceAdapter(channel as PublishChannel)); }

export function buildRefundServiceContext(db: DbClient) {
  const repositories = createRefundRepositoriesForDb(db);
  return createRefundApplicationContext({
    unitOfWork: new SqliteUnitOfWork(db),
    repositories,
    readPorts: {
      orders: {
        findRefundOrder: async (orderId) => { const [o] = await db.select().from(orders).where(eq(orders.id, orderId)); return o ? { id:o.id, currency:o.currency, customerId:o.customerId, totalAmount:o.totalAmount } : null; },
        findRefundItems: async (orderId) => (await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))).map((i:any)=>({ id:i.id, orderId:i.orderId, productId:i.productId, quantity:i.quantity, refundableAmount:i.totalPrice, currency:i.currency })),
      },
      returns: {
        findApprovedReturn: async (returnRequestId) => { const [r] = await db.select().from(returnRequests).where(eq(returnRequests.id, returnRequestId)); return r ? { id:r.id, orderId:r.orderId, status:r.status, approvedAt:(r as any).approvedAt ?? r.updatedAt } : null; },
        findApprovedItems: async (returnRequestId) => (await db.select().from(returnItems).where(eq(returnItems.returnRequestId, returnRequestId))).map((i:any)=>({ id:i.id, returnRequestId:i.returnRequestId, orderItemId:i.orderItemId, quantity:i.quantityApproved ?? i.quantityReceived ?? i.quantityRequested, refundableAmount:0 })),
      },
      marketplaceConnections: {
        findConnection: async (orderId) => { const [mo] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, orderId)); const [c] = mo ? await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.id, mo.marketplaceConnectionId)) : []; return c ? { id:c.id, orderId, marketplace:c.channel, providerKey:c.channel, merchantId:c.accountLabel } : null; },
        resolveProvider: (connection) => connection.providerKey,
      },
      payments: { findPayment: async () => null, findRemainingRefundAmount: () => 0 },
    },
    providerPorts: {
      resolveMarketplaceProvider: async (providerKey) => ({ executeRefund: async (request) => { const [conn] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, providerKey)); if (!conn?.encryptedAccessToken) { const e:any = { type:"Authentication", message:"Marketplace connection missing", retryable:false }; throw e; } const adapter=adapterResolver(providerKey); try { const result = await adapter.submitRefund(decryptCredential(conn.encryptedAccessToken), request as any); return { providerRefundId: result.externalRefundId ?? `refund-${request.refundId}`, status: result.status, raw: result.raw }; } catch (e) { const safe=adapter.normalizeReturnError(e); throw { type: safe.type, message: safe.message, retryable: safe.retryable }; } }, cancelRefund: async (request) => ({ providerRefundId:request.externalRefundId ?? request.refundId, status:"cancelled" }), getRefundStatus: async (request) => ({ providerRefundId:request.externalRefundId ?? request.refundId, status:"unknown" }) }),
      resolvePaymentProvider: async () => ({ executeRefund: async () => { throw new Error("REFUND_PAYMENT_PROVIDER_NOT_CONFIGURED"); }, cancelRefund: async (request) => ({ providerRefundId:request.externalRefundId ?? request.refundId, status:"cancelled" }), getRefundStatus: async (request) => ({ providerRefundId:request.externalRefundId ?? request.refundId, status:"unknown" }) }),
    },
    clock: { now: () => new Date() },
    idGenerator: { newId: () => randomUUID() },
    enqueue: { enqueueRefundExecution: async (refundId) => { await enqueueJob(db, { type: BackgroundJobType.SubmitMarketplaceRefund, payload: { refundId }, idempotencyKey: `refund-submit:${refundId}` }); }, cancelRefundExecution: () => undefined },
    logger: console,
    errorNormalizer: { normalize: (e) => { const safe = sanitizeError(e); return { code: safe.type, message: safe.message, cause: e }; } },
  });
}
