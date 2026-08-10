import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, PublishChannel, StockMovementType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema";
import * as postgresSchema from "../src/db/schema.postgres";
import { createCashOnDeliveryOrder, createOrder, updateOrderStatus } from "../src/services/orders";
import { createPackingTask, createPickingTask, updatePacking, updatePicking } from "../src/services/erpWarehouseBridge";
import { BadRequestError, ConflictError } from "../src/services/errors";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createInternalOrderUseCase, transitionOrderStatusUseCase } from "../src/use-cases/order/useCases";
import { createDrizzleOrderRepositories } from "../src/repositories/order/drizzle";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { persistOrder } from "../src/services/marketplaceSync";
import { encryptCredential } from "../src/services/credentialEncryption";

let db:any;
let seq=0;
const address={fullName:"COD Buyer",line1:"1 Main",city:"Paris",postalCode:"75001",country:"FR"};
const env=(type:string,payload:any={},key=`s130-${++seq}`)=>({commandId:`cmd-${key}`,requestId:`req-${key}`,commandType:type,idempotencyKey:key,payload});

async function seedProduct(id:string,stock=1){
  const now=new Date().toISOString();
  await db.insert(schema.products).values({id,sku:`SKU-${id}`,title:`Product ${id}`,slug:`product-${id}`,type:ProductType.UniqueItem,status:ProductStatus.Published,stockQuantity:stock,priceEur:10,allowCashOnDelivery:true,createdAt:now,updatedAt:now});
}

async function codOrder(id:string){
  const productId=`product-${id}`;
  await seedProduct(productId);
  const order=await createCashOnDeliveryOrder(db,{orderDraftId:`draft-${id}`,guestEmail:"buyer@example.com",billingAddress:address,shippingAddress:address,items:[{productId,quantity:1}]});
  return {order,productId};
}

async function orderAt(status:OrderStatus,id=`order-${++seq}`){
  const {order,productId}=await codOrder(id);
  if(status===OrderStatus.Confirmed) await updateOrderStatus(db,order.id,{status});
  if(status===OrderStatus.Processing) await updateOrderStatus(db,order.id,{status});
  if(status===OrderStatus.Shipped){ await updateOrderStatus(db,order.id,{status:OrderStatus.Processing}); await updateOrderStatus(db,order.id,{status}); }
  if(status===OrderStatus.Cancelled) await updateOrderStatus(db,order.id,{status});
  if(status===OrderStatus.Completed) await db.update(schema.orders).set({status}).where(eq(schema.orders.id,order.id));
  if(status===OrderStatus.Draft) await db.update(schema.orders).set({status}).where(eq(schema.orders.id,order.id));
  return {order:{...order,status},productId};
}

async function paidOrder(channel:"Direct"|"Internal"|"LocalPickup",provider:PaymentProvider,id:string){
  const productId=`product-${id}`;
  await seedProduct(productId);
  const order=await createInternalOrderUseCase(new SqliteUnitOfWork(db)).execute({orderDraftId:`draft-${id}`,idempotencyKey:`draft-${id}`,channel,guestEmail:"buyer@example.com",status:OrderStatus.Processing,paymentStatus:PaymentStatus.Paid,paymentProvider:provider,paymentReference:`payment-${id}`,currency:PriceCurrency.Eur,billingAddress:address,shippingAddress:address,subtotalAmount:10,totalAmount:10,items:[{productId,quantity:1}]});
  return {order,productId};
}

async function stripeDirectOrder(id:string){
  const productId=`product-${id}`;
  await seedProduct(productId);
  const paymentReference=`payment-${id}`;
  await createPaymentSession(db,{provider:PaymentProvider.Stripe,providerReference:paymentReference,status:PaymentStatus.Paid,amount:10,currency:"EUR",idempotencyKey:`payment-session-${id}`});
  const order=await createOrder(db,{orderDraftId:`draft-${id}`,guestEmail:"buyer@example.com",status:OrderStatus.Processing,paymentStatus:PaymentStatus.Paid,paymentProvider:PaymentProvider.Stripe,paymentReference,currency:PriceCurrency.Eur,billingAddress:address,shippingAddress:address,subtotalAmount:10,totalAmount:10,items:[{productId,quantity:1}]});
  return {order,productId};
}

async function marketplaceOrder(id:string){
  const productId=`product-${id}`;
  await seedProduct(productId);
  const now=new Date().toISOString();
  const previousKey=process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY;
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,9).toString("base64");
  const encryptedAccessToken=encryptCredential("sprint-130-token");
  if(previousKey===undefined) delete process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY; else process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY=previousKey;
  await db.insert(schema.marketplaceConnections).values({id:`connection-${id}`,channel:PublishChannel.Ebay,accountLabel:"Sprint 130",encryptedAccessToken,status:"connected",createdAt:now,updatedAt:now});
  const imported=await persistOrder(db,PublishChannel.Ebay,`connection-${id}`,{externalOrderId:`external-${id}`,externalOrderNumber:`number-${id}`,status:"paid",currency:"EUR",subtotal:10,shipping:0,tax:0,total:10,buyerEmail:"buyer@example.com",buyerName:"Buyer",orderedAt:now,items:[{externalOrderItemId:`item-${id}`,sku:`SKU-${productId}`,title:`Product ${id}`,quantity:1,unitPrice:10,lineTotal:10}],raw:{source:"sprint-130"}});
  const [order]=await db.select().from(schema.orders).where(eq(schema.orders.id,imported.internalOrderId!));
  return {order,productId,marketplaceOrder:imported};
}

async function picking(orderId:string){ return createPickingTask(db,"admin",env("CreatePickingTask",{}),orderId); }
async function startPicking(id:string){ return updatePicking(db,"admin",env("StartPickingTask",{}),id,"StartPickingTask"); }
async function pickAll(id:string){
  await startPicking(id);
  const [line]=await db.select().from(schema.pickingTaskLines).where(eq(schema.pickingTaskLines.pickingTaskId,id));
  await updatePicking(db,"admin",env("ConfirmPickedLine",{pickedQuantity:line.requestedQuantity}),id,"ConfirmPickedLine",line.id);
  await updatePicking(db,"admin",env("CompletePickingTask",{}),id,"CompletePickingTask");
}

beforeEach(()=>{db=createTestDb();seq=0;});

describe("Sprint 130 fulfillment and order operations",()=>{
  it("fails fast instead of silently running the synchronous fulfillment guard on PostgreSQL",()=>{
    const select=vi.fn();
    const repositories=createDrizzleOrderRepositories({select} as any,postgresSchema,"postgres");
    expect(()=>repositories.orders.read.hasActiveFulfillmentTasks("order-postgres")).toThrow("ORDER_ACTIVE_FULFILLMENT_CHECK_REQUIRES_SQLITE_TRANSACTION");
    expect(select).not.toHaveBeenCalled();
  });

  it("moves a real COD order Pending -> Processing without settlement or financial artifacts",async()=>{
    const {order}=await codOrder("cod-processing");
    const counts=async()=>({payments:(await db.select().from(schema.payments)).length,events:(await db.select().from(schema.paymentEvents)).length,invoices:(await db.select().from(schema.invoices)).length,outbox:(await db.select().from(schema.outboxEvents)).length});
    const before=await counts();
    const processed=await updateOrderStatus(db,order.id,{status:OrderStatus.Processing});
    expect(processed).toMatchObject({status:OrderStatus.Processing,paymentStatus:PaymentStatus.Pending,paymentProvider:PaymentProvider.CashOnDelivery});
    expect(await counts()).toEqual(before);
  });

  it("keeps the optional Pending -> Confirmed -> Processing path valid",async()=>{
    const {order}=await codOrder("cod-confirmed");
    expect((await updateOrderStatus(db,order.id,{status:OrderStatus.Confirmed})).status).toBe(OrderStatus.Confirmed);
    const processed=await updateOrderStatus(db,order.id,{status:OrderStatus.Processing});
    expect(processed).toMatchObject({status:OrderStatus.Processing,paymentStatus:PaymentStatus.Pending});
  });

  it("creates picking only for Processing orders",async()=>{
    const processing=await orderAt(OrderStatus.Processing,"eligible");
    await expect(picking(processing.order.id)).resolves.toBeTruthy();
    for(const status of [OrderStatus.Draft,OrderStatus.Pending,OrderStatus.Confirmed,OrderStatus.Shipped,OrderStatus.Completed,OrderStatus.Cancelled]){
      const candidate=await orderAt(status,`ineligible-${status}`);
      await expect(picking(candidate.order.id)).rejects.toBeInstanceOf(BadRequestError);
    }
  });

  it("applies Processing picking eligibility without provider or channel branching",async()=>{
    const cod=await orderAt(OrderStatus.Processing,"matrix-cod-direct");
    const stripe=await stripeDirectOrder("matrix-stripe-direct");
    const marketplace=await marketplaceOrder("matrix-marketplace");
    const pickup=await paidOrder("LocalPickup",PaymentProvider.CashOnDelivery,"matrix-local-pickup");
    const persisted=await Promise.all([cod,stripe,marketplace,pickup].map(async candidate=>(await db.select().from(schema.orders).where(eq(schema.orders.id,candidate.order.id)))[0]));
    expect(persisted.map(order=>order.status)).toEqual(Array(4).fill(OrderStatus.Processing));
    expect(persisted[0].paymentProvider).toBe(PaymentProvider.CashOnDelivery);
    expect(persisted[1].paymentProvider).toBe(PaymentProvider.Stripe);
    expect(marketplace.marketplaceOrder).toMatchObject({internalOrderId:marketplace.order.id,channel:PublishChannel.Ebay,status:"processing"});
    // LocalPickup is a canonical creation context, but current Order persistence retains no
    // general sales-channel identity. Fulfillment eligibility is therefore intentionally based
    // only on persisted OrderStatus; adding channel persistence is outside Sprint 130.
    expect(persisted[3]).not.toHaveProperty("channel");
    for(const candidate of [cod,stripe,marketplace,pickup]) await expect(picking(candidate.order.id)).resolves.toMatchObject({status:"Succeeded"});
  });

  it("enforces the picking state machine and cancellation packing guard",async()=>{
    const {order}=await orderAt(OrderStatus.Processing,"picking-state");
    const created:any=await picking(order.id);
    const tid=created.pickingTaskId;
    const [line]=await db.select().from(schema.pickingTaskLines).where(eq(schema.pickingTaskLines.pickingTaskId,tid));
    await expect(updatePicking(db,"admin",env("CompletePickingTask",{}),tid,"CompletePickingTask")).rejects.toBeInstanceOf(BadRequestError);
    await expect(updatePicking(db,"admin",env("ConfirmPickedLine",{}),tid,"ConfirmPickedLine",line.id)).rejects.toBeInstanceOf(BadRequestError);
    await startPicking(tid);
    await updatePicking(db,"admin",env("MarkPickingShort",{shortQuantity:0}),tid,"MarkPickingShort",line.id);
    await updatePicking(db,"admin",env("ConfirmPickedLine",{pickedQuantity:1}),tid,"ConfirmPickedLine",line.id);
    await updatePicking(db,"admin",env("CompletePickingTask",{}),tid,"CompletePickingTask");
    await expect(startPicking(tid)).rejects.toBeInstanceOf(BadRequestError);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:tid}),order.id);
    await expect(updatePicking(db,"admin",env("CancelPickingTask",{}),tid,"CancelPickingTask")).rejects.toBeInstanceOf(BadRequestError);
    await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
    await updatePicking(db,"admin",env("CancelPickingTask",{}),tid,"CancelPickingTask");
    await expect(startPicking(tid)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("allows picking cancellation from Pending, InProgress, and Picked",async()=>{
    for(const state of ["Pending","InProgress","Picked"]){
      const {order}=await orderAt(OrderStatus.Processing,`pick-cancel-${state}`);
      const created:any=await picking(order.id);
      if(state==="InProgress") await startPicking(created.pickingTaskId);
      if(state==="Picked") await pickAll(created.pickingTaskId);
      await updatePicking(db,"admin",env("CancelPickingTask",{}),created.pickingTaskId,"CancelPickingTask");
      const [row]=await db.select().from(schema.pickingTasks).where(eq(schema.pickingTasks.id,created.pickingTaskId));
      expect(row.status).toBe("Cancelled");
    }
  });

  it("validates packing ownership, picking state, order state, and its action graph",async()=>{
    const first=await orderAt(OrderStatus.Processing,"packing-first");
    const second=await orderAt(OrderStatus.Processing,"packing-second");
    const pending:any=await picking(first.order.id);
    await expect(createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pending.pickingTaskId}),first.order.id)).rejects.toBeInstanceOf(BadRequestError);
    await startPicking(pending.pickingTaskId);
    await expect(createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pending.pickingTaskId}),first.order.id)).rejects.toBeInstanceOf(BadRequestError);
    const [line]=await db.select().from(schema.pickingTaskLines).where(eq(schema.pickingTaskLines.pickingTaskId,pending.pickingTaskId));
    await updatePicking(db,"admin",env("ConfirmPickedLine",{pickedQuantity:1}),pending.pickingTaskId,"ConfirmPickedLine",line.id);
    await updatePicking(db,"admin",env("CompletePickingTask",{}),pending.pickingTaskId,"CompletePickingTask");
    await expect(createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pending.pickingTaskId}),second.order.id)).rejects.toBeInstanceOf(BadRequestError);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pending.pickingTaskId}),first.order.id);
    await expect(updatePacking(db,"admin",env("CompletePackingTask",{}),pack.packingTaskId,"CompletePackingTask")).rejects.toBeInstanceOf(BadRequestError);
    await updatePacking(db,"admin",env("UpdatePackingTask",{packageCount:2}),pack.packingTaskId,"UpdatePackingTask");
    await updatePacking(db,"admin",env("StartPackingTask",{}),pack.packingTaskId,"StartPackingTask");
    await updatePacking(db,"admin",env("CompletePackingTask",{}),pack.packingTaskId,"CompletePackingTask");
    await updatePacking(db,"admin",env("MarkPackingReady",{}),pack.packingTaskId,"MarkPackingReady");
    await expect(updatePacking(db,"admin",env("UpdatePackingTask",{packageCount:3}),pack.packingTaskId,"UpdatePackingTask")).rejects.toBeInstanceOf(BadRequestError);
    await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
    await expect(updatePacking(db,"admin",env("StartPackingTask",{}),pack.packingTaskId,"StartPackingTask")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects packing when a completed pick belongs to a non-Processing order",async()=>{
    const {order}=await orderAt(OrderStatus.Processing,"packing-order-state");
    const pick:any=await picking(order.id);
    await pickAll(pick.pickingTaskId);
    await updateOrderStatus(db,order.id,{status:OrderStatus.Shipped});
    await expect(createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pick.pickingTaskId}),order.id)).rejects.toBeInstanceOf(BadRequestError);
    expect(await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.orderId,order.id))).toHaveLength(0);
  });

  it("rejects packing from a Cancelled picking task",async()=>{
    const {order}=await orderAt(OrderStatus.Processing,"packing-cancelled-pick");
    const pick:any=await picking(order.id);
    await updatePicking(db,"admin",env("CancelPickingTask",{}),pick.pickingTaskId,"CancelPickingTask");
    await expect(createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pick.pickingTaskId}),order.id)).rejects.toBeInstanceOf(BadRequestError);
    expect(await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.orderId,order.id))).toHaveLength(0);
  });

  it("replays successful picking and packing commands before revalidating advanced state",async()=>{
    const {order}=await orderAt(OrderStatus.Processing,"command-replay");
    const pick:any=await picking(order.id);
    const startPick=env("StartPickingTask",{},"replay-start-pick");
    const firstStartPick=await updatePicking(db,"admin",startPick,pick.pickingTaskId,"StartPickingTask");
    const replayStartPick:any=await updatePicking(db,"admin",startPick,pick.pickingTaskId,"StartPickingTask");
    expect(firstStartPick.status).toBe("Succeeded");
    expect(replayStartPick.metadata.pickingTaskId).toBe(pick.pickingTaskId);
    await expect(updatePicking(db,"admin",{...startPick,payload:{different:true}},pick.pickingTaskId,"StartPickingTask")).rejects.toBeInstanceOf(ConflictError);
    const [line]=await db.select().from(schema.pickingTaskLines).where(eq(schema.pickingTaskLines.pickingTaskId,pick.pickingTaskId));
    await updatePicking(db,"admin",env("ConfirmPickedLine",{pickedQuantity:1}),pick.pickingTaskId,"ConfirmPickedLine",line.id);
    const completePick=env("CompletePickingTask",{},"replay-complete-pick");
    await updatePicking(db,"admin",completePick,pick.pickingTaskId,"CompletePickingTask");
    expect((await updatePicking(db,"admin",completePick,pick.pickingTaskId,"CompletePickingTask") as any).metadata.pickingTaskId).toBe(pick.pickingTaskId);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pick.pickingTaskId}),order.id);
    const startPack=env("StartPackingTask",{},"replay-start-pack");
    await updatePacking(db,"admin",startPack,pack.packingTaskId,"StartPackingTask");
    expect((await updatePacking(db,"admin",startPack,pack.packingTaskId,"StartPackingTask") as any).metadata.packingTaskId).toBe(pack.packingTaskId);
    await updatePacking(db,"admin",env("CompletePackingTask",{}),pack.packingTaskId,"CompletePackingTask");
    const ready=env("MarkPackingReady",{},"replay-ready-pack");
    await updatePacking(db,"admin",ready,pack.packingTaskId,"MarkPackingReady");
    expect((await updatePacking(db,"admin",ready,pack.packingTaskId,"MarkPackingReady") as any).metadata.packingTaskId).toBe(pack.packingTaskId);
  });

  it("allows packing cancellation from every approved pre-shipment state",async()=>{
    for(const state of ["Pending","InProgress","Packed","ReadyForShipment"]){
      const {order}=await orderAt(OrderStatus.Processing,`pack-cancel-${state}`);
      const pick:any=await picking(order.id); await pickAll(pick.pickingTaskId);
      const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pick.pickingTaskId}),order.id);
      if(state!=="Pending") await updatePacking(db,"admin",env("StartPackingTask",{}),pack.packingTaskId,"StartPackingTask");
      if(state==="Packed"||state==="ReadyForShipment") await updatePacking(db,"admin",env("CompletePackingTask",{}),pack.packingTaskId,"CompletePackingTask");
      if(state==="ReadyForShipment") await updatePacking(db,"admin",env("MarkPackingReady",{}),pack.packingTaskId,"MarkPackingReady");
      await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
      const [row]=await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.id,pack.packingTaskId));
      expect(row.status).toBe("Cancelled");
    }
  });

  it("rejects order cancellation with active fulfillment, then restores inventory once after explicit task cancellation",async()=>{
    const {order,productId}=await orderAt(OrderStatus.Processing,"cancel-guard");
    const created:any=await picking(order.id);
    await expect(updateOrderStatus(db,order.id,{status:OrderStatus.Cancelled})).rejects.toBeInstanceOf(BadRequestError);
    expect((await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(sql`${schema.stockMovements.orderId}=${order.id} AND ${schema.stockMovements.type}=${StockMovementType.SaleRollback}`)).toHaveLength(0);
    await pickAll(created.pickingTaskId);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:created.pickingTaskId}),order.id);
    await expect(updateOrderStatus(db,order.id,{status:OrderStatus.Cancelled})).rejects.toBeInstanceOf(BadRequestError);
    await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
    await updatePicking(db,"admin",env("CancelPickingTask",{}),created.pickingTaskId,"CancelPickingTask");
    await updateOrderStatus(db,order.id,{status:OrderStatus.Cancelled});
    await updateOrderStatus(db,order.id,{status:OrderStatus.Cancelled});
    expect((await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements).where(sql`${schema.stockMovements.orderId}=${order.id} AND ${schema.stockMovements.type}=${StockMovementType.SaleRollback}`)).toHaveLength(1);
  });

  it("isolates active packing as the cancellation blocker and synchronizes exactly once after commit",async()=>{
    const {order,productId}=await orderAt(OrderStatus.Processing,"packing-only-cancel-guard");
    const pick:any=await picking(order.id);
    await pickAll(pick.pickingTaskId);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:pick.pickingTaskId}),order.id);
    await db.update(schema.pickingTasks).set({status:"Cancelled"}).where(eq(schema.pickingTasks.id,pick.pickingTaskId));
    const syncSnapshots:number[]=[];
    const sync={enqueue:vi.fn(async()=>{syncSnapshots.push(Number((await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity));})};
    const transition=transitionOrderStatusUseCase(new SqliteUnitOfWork(db),undefined,undefined,"sqlite",sync);
    await expect(transition.execute({id:order.id,status:OrderStatus.Cancelled})).rejects.toBeInstanceOf(BadRequestError);
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id,order.id)))[0].status).toBe(OrderStatus.Processing);
    expect((await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(sql`${schema.stockMovements.orderId}=${order.id} AND ${schema.stockMovements.type}=${StockMovementType.SaleRollback}`)).toHaveLength(0);
    expect(sync.enqueue).not.toHaveBeenCalled();
    await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
    await transition.execute({id:order.id,status:OrderStatus.Cancelled});
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
    expect(sync.enqueue).toHaveBeenCalledWith(productId,`order-cancel:${order.id}:${productId}`);
    expect(syncSnapshots).toEqual([1]);
    await transition.execute({id:order.id,status:OrderStatus.Cancelled});
    expect((await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements).where(sql`${schema.stockMovements.orderId}=${order.id} AND ${schema.stockMovements.type}=${StockMovementType.SaleRollback}`)).toHaveLength(1);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
  });

  it("task cancellation has no inventory or financial side effects",async()=>{
    const {order,productId}=await orderAt(OrderStatus.Processing,"task-side-effects");
    const created:any=await picking(order.id); await pickAll(created.pickingTaskId);
    const pack:any=await createPackingTask(db,"admin",env("CreatePackingTask",{pickingTaskId:created.pickingTaskId}),order.id);
    const before={stock:(await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity,movements:(await db.select().from(schema.stockMovements)).length,payments:(await db.select().from(schema.payments)).length,events:(await db.select().from(schema.paymentEvents)).length,invoices:(await db.select().from(schema.invoices)).length,outbox:(await db.select().from(schema.outboxEvents)).length};
    await updatePacking(db,"admin",env("CancelPackingTask",{}),pack.packingTaskId,"CancelPackingTask");
    await updatePicking(db,"admin",env("CancelPickingTask",{}),created.pickingTaskId,"CancelPickingTask");
    const after={stock:(await db.select().from(schema.products).where(eq(schema.products.id,productId)))[0].stockQuantity,movements:(await db.select().from(schema.stockMovements)).length,payments:(await db.select().from(schema.payments)).length,events:(await db.select().from(schema.paymentEvents)).length,invoices:(await db.select().from(schema.invoices)).length,outbox:(await db.select().from(schema.outboxEvents)).length};
    expect(after).toEqual(before);
  });
});
