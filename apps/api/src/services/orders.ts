import { OrderStatus, PaymentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { SqliteUnitOfWork } from "./unitOfWork";
import { enqueueProductStockSync } from "./stockSync";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { findPaymentByProviderReference, linkPaymentToOrder } from "../payments/paymentRepository";
import type { CreateOrderInput, OrderListQuery, UpdateOrderStatusInput } from "../validation/order";
import { createInternalOrderUseCase, getOrderDetailUseCase, listOrdersUseCase, transitionOrderStatusUseCase, updateOrderPaymentStatusUseCase, formatOrderNumber } from "../use-cases/order/useCases";

export interface OrderWithItems { id:string; orderNumber:string; items:unknown[]; [key:string]:unknown }
function uow(db:DbClient){ return new SqliteUnitOfWork(db); }
const sync=(db:DbClient)=>({ enqueue:(productId:string,key:string)=>enqueueProductStockSync(db,productId,key).then(()=>undefined) });
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
export async function createOrder(db:DbClient,input:CreateOrderInput):Promise<OrderWithItems>{
  const session = await findPaymentByProviderReference(db, input.paymentProvider, input.paymentReference);
  if (!session) throw new NotFoundError("Payment session not found");
  if (session.status !== PaymentStatus.Paid) throw new BadRequestError("Orders can only be created from paid payments");

  const idempotencyKey = input.orderDraftId;
  const existingOrder = await uow(db).run(({ repositories }) => repositories.order.orders.write.findByIdempotencyKey(idempotencyKey));
  if (session.orderId && session.orderId !== existingOrder?.id) {
    throw new ConflictError("Payment session is already linked to another order");
  }

  const result = await createInternalOrderUseCase(uow(db),sync(db)).execute({ ...input, idempotencyKey, channel:(input as any).channel??"Internal", status:input.status??OrderStatus.Processing, paymentStatus:PaymentStatus.Paid }) as unknown as OrderWithItems;

  await linkPaymentToOrder(db, session.id, result.id).catch(()=>undefined);

  return result;
}
/** Sprint 39A: the canonical transitionOrderStatusUseCase validates the transition and, when cancelling, restores Inventory. */
export async function updateOrderStatus(db:DbClient,id:string,input:UpdateOrderStatusInput):Promise<OrderWithItems>{ return await transitionOrderStatusUseCase(uow(db)).execute({id,status:input.status}) as unknown as OrderWithItems; }
export async function updateOrderPaymentStatus(db:DbClient,id:string,input:{paymentStatus:PaymentStatus}):Promise<OrderWithItems>{ return await updateOrderPaymentStatusUseCase(uow(db)).execute({id,paymentStatus:input.paymentStatus}) as unknown as OrderWithItems; }
export async function cancelOrder(db:DbClient,id:string):Promise<OrderWithItems>{ return await transitionOrderStatusUseCase(uow(db)).execute({id,status:OrderStatus.Cancelled}) as unknown as OrderWithItems; }
/** Retained signature for compatibility; idempotencyKey/reason are no longer needed since transitionOrderStatusUseCase's own same-status check makes cancellation idempotent. */
export async function createSaleRollback(db:DbClient,input:{orderId:string;idempotencyKey:string;reason?:string}){ return transitionOrderStatusUseCase(uow(db)).execute({id:input.orderId,status:OrderStatus.Cancelled}); }
export async function listOrders(db:DbClient,query:OrderListQuery){ let result=await listOrdersUseCase(uow(db)).execute(query); if(query.status) result={...result,items:result.items.filter((i:any)=>i.status===query.status),total:result.items.filter((i:any)=>i.status===query.status).length}; if(query.paymentStatus) result={...result,items:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus),total:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus).length}; return { data: await Promise.all(result.items.map((i:any)=>getOrderById(db,i.id))), pagination:{ page:query.page, pageSize:query.pageSize, total:result.total, totalPages:Math.ceil(result.total/query.pageSize) } }; }
export const searchOrders = listOrders;
