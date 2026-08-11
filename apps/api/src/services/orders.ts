import { OrderStatus, PaymentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { SqliteUnitOfWork } from "./unitOfWork";
import { enqueueProductStockSync } from "./stockSync";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { findPaymentByProviderReference, linkPaymentToOrder } from "../payments/paymentRepository";
import type { CreateCashOnDeliveryOrderInput, CreateOrderInput, OrderListQuery, UpdateOrderStatusInput } from "../validation/order";
import { createCashOnDeliveryOrderUseCase, createInternalOrderUseCase, getOrderDetailUseCase, listOrdersUseCase, settleCashOnDeliveryOrderUseCase, transitionOrderStatusUseCase, updateOrderPaymentStatusUseCase, formatOrderNumber, type PaidOrderOutboxPort } from "../use-cases/order/useCases";
import { dispatchDueSalesInvoiceOutboxEvents, enqueueSalesInvoiceDraftForPaidOrderSync } from "./salesInvoiceOutbox";
import type { OrderPricingContext } from "../repositories/order/types";

export interface OrderWithItems { id:string; orderNumber:string; items:unknown[]; [key:string]:unknown }
function uow(db:DbClient){ return new SqliteUnitOfWork(db); }
const sync=(db:DbClient)=>({ enqueue:(productId:string,key:string)=>enqueueProductStockSync(db,productId,key).then(()=>undefined) });
/**
 * Sprint 79 correction: the real (invoice-domain-aware) implementation of the generic
 * PaidOrderOutboxPort the Order use cases call — kept here, not in the use-case file, so Order
 * use cases stay domain-agnostic about what "paid order" durably signals. Same transaction as the
 * order/payment-status write (see createInternalOrderUseCase / updateOrderPaymentStatusUseCase).
 */
const paidOrderOutbox:PaidOrderOutboxPort = { enqueue:(tx,orderId)=>enqueueSalesInvoiceDraftForPaidOrderSync(tx,orderId) };
export { formatOrderNumber };
export async function getOrderById(db:DbClient,id:string):Promise<OrderWithItems>{ return await getOrderDetailUseCase(uow(db)).execute(id) as unknown as OrderWithItems; }
export async function getOrderByOrderNumber(db:DbClient,orderNumber:string):Promise<OrderWithItems>{ const found=await listOrdersUseCase(uow(db)).execute({page:1,pageSize:1,search:orderNumber}); return getOrderById(db, found.items[0]?.id ?? orderNumber); }
/**
 * The persisted Payment Session (Sprint 37A) is the server-side source of
 * truth for payment status — input.paymentStatus is accepted for request-
 * shape compatibility but never trusted for the pay/no-pay decision.
 * Linking payments.order_id happens post-commit (Sprint 38A): SqliteUnitOfWork.run()
 * rejects any transaction callback that returns a Promise, so the async
 * payment repository calls stay outside uow.run() entirely.
 */
/**
 * Sprint 79 correction: `enqueueInvoiceDraft` is the explicit, non-fragile caller option that
 * distinguishes real storefront/internal checkout (default true) from marketplace order import
 * (marketplaceSync.ts explicitly passes false — marketplace invoicing is deferred until
 * marketplace integrations are activated, see salesInvoiceOutbox.ts). Never inferred from title,
 * email, or channel string (channel already defaults to "Internal" for both callers today, so it
 * is not a reliable signal).
 */
export async function createOrder(db:DbClient,input:CreateOrderInput,options:{ enqueueInvoiceDraft?:boolean; pricingContext?:OrderPricingContext }={}):Promise<OrderWithItems>{
  const session = await findPaymentByProviderReference(db, input.paymentProvider, input.paymentReference);
  if (!session) throw new NotFoundError("Payment session not found");
  if (session.status !== PaymentStatus.Paid) throw new BadRequestError("Orders can only be created from paid payments");
  const pricingContext = options.pricingContext ?? "canonical";
  if (pricingContext === "noctella_web" && session.currency !== "EUR") throw new BadRequestError("Noctella Web payments must use EUR");

  const idempotencyKey = input.orderDraftId;
  const existingOrder = await uow(db).run(({ repositories }) => repositories.order.orders.write.findByIdempotencyKey(idempotencyKey));
  if (session.orderId && session.orderId !== existingOrder?.id) {
    throw new ConflictError("Payment session is already linked to another order");
  }

  const outbox = options.enqueueInvoiceDraft===false ? undefined : paidOrderOutbox;
  const result = await createInternalOrderUseCase(uow(db),sync(db),undefined,undefined,"sqlite",outbox,pricingContext,{ amount:session.amount, currency:session.currency }).execute({ ...input, idempotencyKey, channel:(input as any).channel??"Internal", status:input.status??OrderStatus.Processing, paymentStatus:PaymentStatus.Paid }) as unknown as OrderWithItems;

  await linkPaymentToOrder(db, session.id, result.id).catch(()=>undefined);
  // Sprint 79: the durable outbox event (enqueued above, inside the same transaction as the order
  // and stock mutation) is the actual guarantee — this is only a best-effort immediate dispatch
  // attempt for responsiveness, so most orders get their invoice draft without waiting for the
  // next scheduled dispatch cycle. The durable event already exists and remains fully retryable
  // through the normal outbox mechanism regardless of whether this attempt succeeds.
  if (outbox) await dispatchDueSalesInvoiceOutboxEvents(db, "post-commit", 1).catch(()=>undefined);

  return result;
}
export async function createCashOnDeliveryOrder(db:DbClient,input:CreateCashOnDeliveryOrderInput):Promise<OrderWithItems>{ return createCashOnDeliveryOrderUseCase(uow(db),sync(db)).execute(input) as unknown as Promise<OrderWithItems>; }
/** Sprint 39A: the canonical transitionOrderStatusUseCase validates the transition and, when cancelling, restores Inventory. */
export async function updateOrderStatus(db:DbClient,id:string,input:UpdateOrderStatusInput):Promise<OrderWithItems>{ return await transitionOrderStatusUseCase(uow(db),undefined,undefined,"sqlite",sync(db)).execute({id,status:input.status}) as unknown as OrderWithItems; }
/** Sprint 79 correction: the hook point for a Draft order (e.g. one derived from an accepted offer) transitioning into Paid after creation — see updateOrderPaymentStatusUseCase for the exact not-already-Paid -> Paid guard. */
export async function updateOrderPaymentStatus(db:DbClient,id:string,input:{paymentStatus:PaymentStatus}):Promise<OrderWithItems>{ const result=await updateOrderPaymentStatusUseCase(uow(db),paidOrderOutbox).execute({id,paymentStatus:input.paymentStatus}) as unknown as OrderWithItems; if(input.paymentStatus===PaymentStatus.Paid) await dispatchDueSalesInvoiceOutboxEvents(db,"post-commit",1).catch(()=>undefined); return result; }
/** Sprint 132/133: explicit Cash on Delivery settlement - wired to the same paidOrderOutbox seam updateOrderPaymentStatus above uses, so a first-time (non-replay) settlement enqueues the durable SalesInvoiceDraftRequested intent atomically with the settlement transaction (see settleCashOnDeliveryOrderUseCase's own doc comment). The post-commit dispatch attempt below is the same best-effort responsiveness optimization as updateOrderPaymentStatus's — the durable outbox row + scheduler/retry/dead-letter path remains authoritative regardless of whether this attempt succeeds. Never issues an invoice and never creates a financeEntries row. */
export async function settleCashOnDeliveryOrder(db:DbClient,id:string,input:{collectedAmount:number}):Promise<OrderWithItems>{ const result=await settleCashOnDeliveryOrderUseCase(uow(db),paidOrderOutbox).execute({orderId:id,collectedAmount:input.collectedAmount}); await dispatchDueSalesInvoiceOutboxEvents(db,"post-commit",1).catch(()=>undefined); return result.order as unknown as OrderWithItems; }
export async function cancelOrder(db:DbClient,id:string):Promise<OrderWithItems>{ return await transitionOrderStatusUseCase(uow(db),undefined,undefined,"sqlite",sync(db)).execute({id,status:OrderStatus.Cancelled}) as unknown as OrderWithItems; }
/** Retained signature for compatibility; idempotencyKey/reason are no longer needed since transitionOrderStatusUseCase's own same-status check makes cancellation idempotent. */
export async function createSaleRollback(db:DbClient,input:{orderId:string;idempotencyKey:string;reason?:string}){ return transitionOrderStatusUseCase(uow(db),undefined,undefined,"sqlite",sync(db)).execute({id:input.orderId,status:OrderStatus.Cancelled}); }
export async function listOrders(db:DbClient,query:OrderListQuery){ let result=await listOrdersUseCase(uow(db)).execute(query); if(query.status) result={...result,items:result.items.filter((i:any)=>i.status===query.status),total:result.items.filter((i:any)=>i.status===query.status).length}; if(query.paymentStatus) result={...result,items:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus),total:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus).length}; return { data: await Promise.all(result.items.map((i:any)=>getOrderById(db,i.id))), pagination:{ page:query.page, pageSize:query.pageSize, total:result.total, totalPages:Math.ceil(result.total/query.pageSize) } }; }
export const searchOrders = listOrders;
