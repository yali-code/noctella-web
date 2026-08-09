import { randomUUID, createHash } from "node:crypto";
import { OrderStatus, PaymentStatus, PriceCurrency, ProductStatus } from "@noctella/shared";
import type { TransactionScopedRepositories, UnitOfWork } from "../../services/unitOfWork";
import { BadRequestError, NotFoundError } from "../../services/errors";
import type { CreateInternalOrderInput, OrderDetailProjection, OrderPricingContext, PaidSessionPricing, UpdateOrderPaymentStatusInput, UpdateOrderStatusInput, SaleRollbackInput } from "../../repositories/order/types";
import { decreaseInventoryForSaleInTransactionUseCase, restoreInventoryForSaleRollbackInTransactionUseCase } from "../../application/inventory";
import { createInventoryRepositoryBundleForDb, type InventoryRepositoryDriver } from "../../repositories/inventory/factory";

export interface Clock { now(): Date } export interface IdGenerator { id(): string } export interface PostCommitStockSyncPort { enqueue(productId:string, key:string): Promise<void> }
/** Sprint 79 correction: a generic, domain-agnostic hook so this Order use case never needs to import invoice-domain code — it only knows "enqueue this durable signal, using the same transaction handle, for a newly (not idempotent-replay) created paid order." services/orders.ts supplies the real (invoice-specific) implementation. */
export interface PaidOrderOutboxPort { enqueue(tx:import("../../db/client").DbClient, orderId:string): void }
const clock:Clock={now:()=>new Date()}; const ids:IdGenerator={id:()=>randomUUID()};
export function stablePayload(input:unknown){ return createHash("sha256").update(JSON.stringify(input,Object.keys(input as object).sort())).digest("hex"); }
export function formatOrderNumber(date = new Date(), sequence = Math.floor(Math.random()*1_000_000)){ return `NOC-${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,"0")}${String(date.getUTCDate()).padStart(2,"0")}-${String(sequence).padStart(6,"0")}`; }
export const toEurCents = (amount: number) => Math.round((amount + Number.EPSILON) * 100);
export class TerminalStockUnavailableError extends BadRequestError { readonly code="INSUFFICIENT_STOCK"; constructor(){super("Insufficient stock");} }
export class TerminalCheckoutPriceChangedError extends BadRequestError { readonly code="CHECKOUT_PRICE_CHANGED"; constructor(){super("Paid session does not match current Noctella Web price");} }
export interface ResolvedNoctellaWebOrder { subtotal:number; subtotalCents:number; lines:Array<{product:any;quantity:number;unitPrice:number;title:string}> }
export function resolveNoctellaWebOrder(items:Array<{productId:string;quantity:number}>,products:any[]):ResolvedNoctellaWebOrder { if(products.length!==items.length) throw new NotFoundError("Product not found"); let subtotal=0; const lines=items.map(line=>{const product=products.find(p=>p.id===line.productId); if(!product||product.status!==ProductStatus.Published) throw new BadRequestError("Orders can only include published products"); if(product.stockQuantity<line.quantity) throw new TerminalStockUnavailableError(); const unitPrice=product.wooListingPriceEur??product.priceEur; subtotal+=unitPrice*line.quantity; return{product,quantity:line.quantity,unitPrice,title:product.wooProductName??product.title};}); return{subtotal,subtotalCents:toEurCents(subtotal),lines}; }

export interface InternalOrderTransactionContext {
  repositories: TransactionScopedRepositories;
  clock: Clock;
  idGenerator: IdGenerator;
  inventoryDriver: InventoryRepositoryDriver;
  outbox?: PaidOrderOutboxPort;
  pricingContext: OrderPricingContext;
  paidSession?: PaidSessionPricing;
  orderId: string;
  idempotencyKey: string;
}

export interface InternalOrderTransactionResult {
  order: OrderDetailProjection;
  affectedProductIds: string[];
}

/**
 * Canonical order finalization inside an already-open transaction. It returns synchronously for
 * transaction-scoped SQLite and preserves the existing Promise contract for async-capable drivers.
 * It owns no UnitOfWork and performs no post-commit/external work.
 */
export function finalizeInternalOrderInTransaction(
  input: CreateInternalOrderInput,
  context: InternalOrderTransactionContext,
): InternalOrderTransactionResult | Promise<InternalOrderTransactionResult> {
  const { repositories, clock: c, idGenerator: g, inventoryDriver: driver, outbox, pricingContext, paidSession, orderId, idempotencyKey: idem } = context;
  const inventoryRepositories = createInventoryRepositoryBundleForDb(repositories.db, driver, driver === "sqlite");
  const existing = repositories.order.orders.write.findByIdempotencyKey(idem) as any;
  if (existing?.id) {
    return {
      order: repositories.order.orders.read.getOrderDetailProjection(existing.id) as any,
      affectedProductIds: [],
    };
  }
  const products = repositories.order.orderItems.write.validateProductReferences(input.items.map((i) => i.productId)) as unknown as any[];
  if (products.length !== input.items.length) throw new NotFoundError("Product not found");
  const now = c.now().toISOString();
  let subtotal = 0;
  const itemRows = [] as any[];
  const resolved = pricingContext === "noctella_web" ? resolveNoctellaWebOrder(input.items,products) : null;
  for (const line of input.items) {
    const p = products.find((x: any) => x.id === line.productId);
    if (!resolved && (!p || p.status !== ProductStatus.Published)) throw new BadRequestError("Orders can only include published products");
    if (!resolved && p.stockQuantity < line.quantity) throw new TerminalStockUnavailableError();
    const resolvedLine=resolved?.lines.find(x=>x.product.id===line.productId); const unitPrice = resolvedLine?.unitPrice ?? p.priceEur;
    subtotal += unitPrice * line.quantity;
    const productTitle = resolvedLine?.title ?? p.title;
    itemRows.push({ id: g.id(), orderId, productId: p.id, productSku: p.sku, productTitle, productSlug: p.slug, productType: p.type, productImageUrl: p.imageUrl, quantity: line.quantity, unitPrice, totalPrice: unitPrice * line.quantity, currency: "EUR", createdAt: now, updatedAt: now });
  }
  const subtotalCents = toEurCents(subtotal);
  if (toEurCents(input.subtotalAmount) !== subtotalCents || toEurCents(input.totalAmount) !== subtotalCents) { if(pricingContext==="noctella_web") throw new TerminalCheckoutPriceChangedError(); throw new BadRequestError("Submitted totals do not match current product prices"); }
  if (pricingContext === "noctella_web" && (!paidSession || paidSession.currency !== "EUR" || toEurCents(paidSession.amount) !== subtotalCents)) throw new TerminalCheckoutPriceChangedError();
  repositories.order.orders.write.create({ id: orderId, orderNumber: input.orderNumber ?? formatOrderNumber(c.now()), orderDraftId: idem, guestEmail: input.guestEmail, customerId: input.customerId, status: input.status, paymentStatus: input.paymentStatus, paymentProvider: input.paymentProvider as any, paymentReference: input.paymentReference, subtotalAmount: subtotal, shippingAmount: 0, taxAmount: 0, totalAmount: subtotal, currency: "EUR" as any, billingAddress: input.billingAddress, shippingAddress: input.shippingAddress, notes: input.notes, createdAt: now, updatedAt: now, idempotencyKey: idem });
  repositories.order.orderItems.write.createMany(itemRows);
  const affectedProductIds: string[] = [];
  const complete = (): InternalOrderTransactionResult => {
    outbox?.enqueue(repositories.db, orderId);
    const order = repositories.order.orders.read.getOrderDetailProjection(orderId) as any;
    if (!order) throw new NotFoundError("Order not found");
    return { order, affectedProductIds };
  };
  const mutate = (index: number): InternalOrderTransactionResult | Promise<InternalOrderTransactionResult> => {
    if (index >= itemRows.length) return complete();
    const row = itemRows[index];
    const result = decreaseInventoryForSaleInTransactionUseCase({ clock: c, idGenerator: { newId: () => g.id() } }, inventoryRepositories, { productId: row.productId, quantity: row.quantity, orderId, orderItemId: row.id, note: `Sale for order ${orderId}`, idempotencyKey: `order-sale:${orderId}:${row.productId}` });
    return result instanceof Promise
      ? result.then(() => { affectedProductIds.push(row.productId); return mutate(index + 1); })
      : ((affectedProductIds.push(row.productId)), mutate(index + 1));
  };
  return mutate(0);
}

export function createInternalOrderUseCase(
  uow: UnitOfWork,
  sync?: PostCommitStockSyncPort,
  c: Clock = clock,
  g: IdGenerator = ids,
  driver: InventoryRepositoryDriver = "sqlite",
  outbox?: PaidOrderOutboxPort,
  pricingContext: OrderPricingContext = "canonical",
  paidSession?: PaidSessionPricing,
) {
  return {
    async execute(input: CreateInternalOrderInput): Promise<OrderDetailProjection> {
      if (!["Internal", "Direct", "LocalPickup"].includes(input.channel)) throw new BadRequestError("Unsupported order channel");
      if (input.paymentStatus !== PaymentStatus.Paid) throw new BadRequestError("Orders can only be created from paid payments");
      if (!input.paymentReference?.trim()) throw new BadRequestError("Payment reference is required");
      if (input.currency !== PriceCurrency.Eur && input.currency !== "EUR") throw new BadRequestError("Only EUR orders are supported for now");
      if (input.items.some((i) => !Number.isInteger(i.quantity) || i.quantity <= 0)) throw new BadRequestError("Order quantities must be positive integers");
      const idem = input.idempotencyKey ?? input.orderDraftId;
      const keyHash = stablePayload({ ...input, id: undefined, orderNumber: undefined });
      const orderId = input.id ?? g.id();
      const result = await uow.run(({ repositories }) => finalizeInternalOrderInTransaction(input, { repositories, clock: c, idGenerator: g, inventoryDriver: driver, outbox, pricingContext, paidSession, orderId, idempotencyKey: idem }));
      for (const p of result.affectedProductIds) await sync?.enqueue(p, `order-sale:${orderId}:${p}`).catch(() => undefined);
      void keyHash;
      return result.order;
    },
  };
}
export const getOrderDetailUseCase=(uow:UnitOfWork)=>({execute:(id:string)=>uow.run(({repositories})=>{const o=repositories.order.orders.read.getOrderDetailProjection(id); if(!o) throw new NotFoundError("Order not found"); return o;})});
export interface CreateDraftOrderFromOfferInput { offerId:string; productId:string; customerName:string; customerEmail:string; offeredAmount:number; currency:string }
/**
 * Draft Order creation is an explicit admin action on an Accepted offer, not
 * a side effect of accepting it. It only copies customer/product/amount/
 * currency onto a Draft order row — no inventory, payment, or shipment side
 * effects, unlike createInternalOrderUseCase.
 */
export function createDraftOrderFromOfferUseCase(uow:UnitOfWork,c:Clock=clock,g:IdGenerator=ids){ return { execute(input:CreateDraftOrderFromOfferInput):Promise<OrderDetailProjection>{ return uow.run(({repositories})=>{ const existing=repositories.order.orders.read.getByOfferId(input.offerId) as any; if(existing) throw new BadRequestError("Offer already has a Draft Order"); const products=repositories.order.orderItems.write.validateProductReferences([input.productId]) as unknown as any[]; const p=products[0]; if(!p) throw new NotFoundError("Product not found"); const now=c.now().toISOString(); const orderId=g.id(); const placeholderAddress={ fullName:input.customerName, line1:"", city:"", postalCode:"", country:"" }; repositories.order.orders.write.create({ id:orderId, orderNumber:formatOrderNumber(c.now()), offerId:input.offerId, guestEmail:input.customerEmail, status:OrderStatus.Draft, paymentStatus:PaymentStatus.Pending, subtotalAmount:input.offeredAmount, shippingAmount:0, taxAmount:0, totalAmount:input.offeredAmount, currency:input.currency, billingAddress:placeholderAddress as any, shippingAddress:placeholderAddress as any, createdAt:now, updatedAt:now } as any); repositories.order.orderItems.write.createMany([{ id:g.id(), orderId, productId:p.id, productSku:p.sku, productTitle:p.title, productSlug:p.slug, productType:p.type, productImageUrl:p.imageUrl, quantity:1, unitPrice:input.offeredAmount, totalPrice:input.offeredAmount, currency:input.currency, createdAt:now, updatedAt:now }]); return repositories.order.orders.read.getOrderDetailProjection(orderId) as any; }); } }; }
export const listOrdersUseCase=(uow:UnitOfWork)=>({execute:(q:any)=>uow.run(({repositories})=> q.search?repositories.order.orders.read.search(q.search,q):repositories.order.orders.read.list(q))});
export const updateOrderStatusUseCase=(uow:UnitOfWork)=>({execute:(i:UpdateOrderStatusInput)=>uow.run(({repositories})=>{const o=repositories.order.orders.write.updateStatus(i); if(!o) throw new NotFoundError("Order not found"); return repositories.order.orders.read.getOrderDetailProjection(i.id);})});
/** Completed is reserved exclusively for the completeSale() flow (shipment/payment readiness + optimistic concurrency, via sales-completion) — the generic transition Use Case must never reach it, so Shipped has no outgoing edges here. */
export const ORDER_STATUS_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { [OrderStatus.Draft]:[OrderStatus.Pending,OrderStatus.Confirmed,OrderStatus.Cancelled], [OrderStatus.Pending]:[OrderStatus.Confirmed,OrderStatus.Processing,OrderStatus.Cancelled], [OrderStatus.Confirmed]:[OrderStatus.Processing,OrderStatus.Cancelled], [OrderStatus.Processing]:[OrderStatus.Shipped,OrderStatus.Cancelled], [OrderStatus.Shipped]:[], [OrderStatus.Completed]:[], [OrderStatus.Cancelled]:[] };
/**
 * Canonical Order status transition Use Case (Sprint 39A). Replaces
 * updateOrderStatusUseCase as the runtime entry point for status changes:
 * validates the current status against ORDER_STATUS_TRANSITIONS, treats a
 * same-status request as an idempotent success, and — only when
 * transitioning to Cancelled — restores Inventory via the same canonical
 * restoreInventoryForSaleRollbackInTransactionUseCase createSaleRollbackUseCase
 * already used. Orders with an offerId (Draft Orders created via
 * createDraftOrderFromOfferUseCase) never decrement Inventory at creation,
 * so cancelling one must not restore Inventory either.
 */
export function transitionOrderStatusUseCase(uow:UnitOfWork,c:Clock=clock,g:IdGenerator=ids,driver:InventoryRepositoryDriver="sqlite"){ return { execute(input:UpdateOrderStatusInput):Promise<OrderDetailProjection>{ return uow.run(({repositories})=>{ const order=repositories.order.orders.read.getById(input.id) as any; if(!order) throw new NotFoundError("Order not found"); if(order.status===input.status) return repositories.order.orders.read.getOrderDetailProjection(input.id) as any; const allowed=ORDER_STATUS_TRANSITIONS[order.status as OrderStatus]??[]; if(!allowed.includes(input.status)) throw new BadRequestError("Invalid order status transition"); if(input.status===OrderStatus.Cancelled && !order.offerId){ const inventoryRepositories=createInventoryRepositoryBundleForDb(repositories.db,driver,driver==="sqlite"); const items=repositories.order.orderItems.read.listByOrder(input.id) as unknown as any[]; const mutate=(index:number):any=>{ if(index>=items.length){ repositories.order.orders.write.updateStatus({id:input.id,status:input.status}); return repositories.order.orders.read.getOrderDetailProjection(input.id) as any; } const it=items[index]; const result=restoreInventoryForSaleRollbackInTransactionUseCase({clock:c,idGenerator:{newId:()=>g.id()}},inventoryRepositories,{productId:it.productId,quantity:it.quantity,orderId:input.id,orderItemId:it.id,note:"Order cancelled",idempotencyKey:`order-cancel:${input.id}:${it.productId}`}); return result instanceof Promise?result.then(()=>mutate(index+1)):mutate(index+1); }; return mutate(0); } repositories.order.orders.write.updateStatus({id:input.id,status:input.status}); return repositories.order.orders.read.getOrderDetailProjection(input.id) as any; }); } }; }
/**
 * Sprint 79 correction: the only existing hook point for an order (e.g. one derived from an
 * accepted offer, see createDraftOrderFromOfferUseCase) transitioning into PaymentStatus.Paid
 * after having been created unpaid. Enqueues the same durable outbox event createInternalOrderUseCase
 * does, and only on a genuine not-already-Paid -> Paid transition, in the same transaction as the
 * status write — never when the Draft order is first created (still unpaid) and never a duplicate
 * on a repeated/no-op call (idempotency-key check inside the port makes a second enqueue a no-op
 * regardless, but the previous-status guard avoids even attempting it).
 */
export const updateOrderPaymentStatusUseCase=(uow:UnitOfWork,outbox?:PaidOrderOutboxPort)=>({execute:(i:UpdateOrderPaymentStatusInput)=>uow.run(({repositories})=>{const before=repositories.order.orders.read.getById(i.id) as any; if(!before) throw new NotFoundError("Order not found"); const o=repositories.order.orders.write.updatePaymentStatus(i); if(!o) throw new NotFoundError("Order not found"); if(before.paymentStatus!==PaymentStatus.Paid && i.paymentStatus===PaymentStatus.Paid) outbox?.enqueue(repositories.db,i.id); return repositories.order.orders.read.getOrderDetailProjection(i.id);})});
export const cancelInternalOrderUseCase=(uow:UnitOfWork)=>({execute:(id:string)=>updateOrderStatusUseCase(uow).execute({id,status:OrderStatus.Cancelled as any})});
export const createSaleRollbackUseCase=(uow:UnitOfWork,sync?:PostCommitStockSyncPort,g:IdGenerator=ids,c:Clock=clock,driver:InventoryRepositoryDriver="sqlite")=>({async execute(input:SaleRollbackInput){const affected:string[]=[]; const out=await uow.run(({repositories})=>{const inventoryRepositories=createInventoryRepositoryBundleForDb(repositories.db,driver,driver==="sqlite"); const items=repositories.order.orderItems.read.listByOrder(input.orderId) as unknown as any[]; const mutate=(index:number):any=>{if(index>=items.length)return repositories.order.orders.write.updateStatus({id:input.orderId,status:OrderStatus.Cancelled as any});const it=items[index];const result=restoreInventoryForSaleRollbackInTransactionUseCase({clock:c,idGenerator:{newId:()=>g.id()}},inventoryRepositories,{productId:it.productId,quantity:it.quantity,orderId:input.orderId,orderItemId:it.id,note:input.reason,idempotencyKey:`${input.idempotencyKey}:${it.productId}`});return result instanceof Promise?result.then(()=>{affected.push(it.productId);return mutate(index+1);}):((affected.push(it.productId)),mutate(index+1));};const result=mutate(0);return result instanceof Promise?result.then(()=>repositories.order.orders.read.getOrderDetailProjection(input.orderId)):repositories.order.orders.read.getOrderDetailProjection(input.orderId);});for(const p of affected)await sync?.enqueue(p,`rollback:${input.orderId}:${p}`).catch(()=>undefined);return out;}});
