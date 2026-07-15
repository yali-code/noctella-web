import { OrderStatus, PaymentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { SqliteUnitOfWork } from "./unitOfWork";
import { enqueueProductStockSync } from "./stockSync";
import type { CreateOrderInput, OrderListQuery, UpdateOrderStatusInput } from "../validation/order";
import { createInternalOrderUseCase, getOrderDetailUseCase, listOrdersUseCase, updateOrderStatusUseCase, updateOrderPaymentStatusUseCase, cancelInternalOrderUseCase, createSaleRollbackUseCase, formatOrderNumber } from "../use-cases/order/useCases";

export interface OrderWithItems { id:string; orderNumber:string; items:unknown[]; [key:string]:unknown }
function uow(db:DbClient){ return new SqliteUnitOfWork(db); }
const sync=(db:DbClient)=>({ enqueue:(productId:string,key:string)=>enqueueProductStockSync(db,productId,key).then(()=>undefined) });
export { formatOrderNumber };
export async function getOrderById(db:DbClient,id:string):Promise<OrderWithItems>{ return await getOrderDetailUseCase(uow(db)).execute(id) as unknown as OrderWithItems; }
export async function getOrderByOrderNumber(db:DbClient,orderNumber:string):Promise<OrderWithItems>{ const found=await listOrdersUseCase(uow(db)).execute({page:1,pageSize:1,search:orderNumber}); return getOrderById(db, found.items[0]?.id ?? orderNumber); }
export async function createOrder(db:DbClient,input:CreateOrderInput):Promise<OrderWithItems>{ return await createInternalOrderUseCase(uow(db),sync(db)).execute({ ...input, idempotencyKey:input.orderDraftId, channel:(input as any).channel??"Internal", status:input.status??OrderStatus.Processing, paymentStatus:input.paymentStatus??PaymentStatus.Paid }) as unknown as OrderWithItems; }
export async function updateOrderStatus(db:DbClient,id:string,input:UpdateOrderStatusInput):Promise<OrderWithItems>{ return await updateOrderStatusUseCase(uow(db)).execute({id,status:input.status}) as unknown as OrderWithItems; }
export async function updateOrderPaymentStatus(db:DbClient,id:string,input:{paymentStatus:PaymentStatus}):Promise<OrderWithItems>{ return await updateOrderPaymentStatusUseCase(uow(db)).execute({id,paymentStatus:input.paymentStatus}) as unknown as OrderWithItems; }
export async function cancelOrder(db:DbClient,id:string):Promise<OrderWithItems>{ return await cancelInternalOrderUseCase(uow(db)).execute(id) as unknown as OrderWithItems; }
export async function createSaleRollback(db:DbClient,input:{orderId:string;idempotencyKey:string;reason?:string}){ return createSaleRollbackUseCase(uow(db),sync(db)).execute(input); }
export async function listOrders(db:DbClient,query:OrderListQuery){ let result=await listOrdersUseCase(uow(db)).execute(query); if(query.status) result={...result,items:result.items.filter((i:any)=>i.status===query.status),total:result.items.filter((i:any)=>i.status===query.status).length}; if(query.paymentStatus) result={...result,items:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus),total:result.items.filter((i:any)=>i.paymentStatus===query.paymentStatus).length}; return { data: await Promise.all(result.items.map((i:any)=>getOrderById(db,i.id))), pagination:{ page:query.page, pageSize:query.pageSize, total:result.total, totalPages:Math.ceil(result.total/query.pageSize) } }; }
export const searchOrders = listOrders;
