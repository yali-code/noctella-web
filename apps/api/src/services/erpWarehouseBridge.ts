import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { audit } from "./erpIntegration";

type Env={commandId:string;requestId?:string;commandType:string;entityType?:string;entityId?:string;idempotencyKey:string;payload?:any};
const now=()=>new Date().toISOString();
const id=()=>crypto.randomUUID();
const sum=(v:any)=>crypto.createHash("sha256").update(JSON.stringify(v??{})).digest("hex");
const safe=(v:any)=>JSON.stringify(v??{}).slice(0,4000);
async function all(db:DbClient, q:any){ return (await db.all(q)) as any[]; }
async function get(db:DbClient, q:any){ return ((await db.all(q)) as any[])[0]; }

/** Sprint 51B: same policy value as Sprint 46B/47B/48B/49B, kept local so this file's command lifecycle stays self-contained. */
const ERP_WAREHOUSE_COMMAND_ACCEPTED_STALE_MS = 60_000;
function safeErrorCodeFor(error:unknown):string{ if(error instanceof BadRequestError) return "BadRequestError"; if(error instanceof ConflictError) return "ConflictError"; if(error instanceof NotFoundError) return "NotFoundError"; return "InternalError"; }

/**
 * Sprint 51B: replaces exec(). If a matching-checksum row exists and is
 * Succeeded, returns it (caller replays without re-executing). Accepted rows
 * younger than the stale threshold reject as in-progress; stale Accepted or
 * Failed rows are reused (reset to Accepted) so business logic executes
 * again. A brand new key/idempotencyKey is inserted as Accepted. A UNIQUE
 * collision on that insert (concurrent first callers) re-enters this same
 * function instead of leaking the raw SQLite error.
 */
async function startCommand(db:DbClient, clientId:string, env:Env, type:string, entityType:string, entityId?:string): Promise<any|null> {
 if(!env?.idempotencyKey||!env?.commandId) throw new BadRequestError("Valid ERP command envelope is required");
 const checksum=sum({type,entityId,payload:env.payload??{}});
 const existing=await get(db, sql`SELECT * FROM erp_command_executions WHERE client_id=${clientId} AND idempotency_key=${env.idempotencyKey} LIMIT 1`);
 if(existing){
   if(existing.request_checksum!==checksum) throw new ConflictError("Idempotency key was already used for a different payload");
   if(existing.status==='Succeeded') return existing;
   if(existing.status==='Accepted'){
     const isStale=Date.now()-new Date(existing.created_at).getTime()>ERP_WAREHOUSE_COMMAND_ACCEPTED_STALE_MS;
     if(!isStale) throw new ConflictError("ERP command is already in progress");
   }
   // Stale Accepted or Failed: reuse the same row rather than inserting a duplicate.
   await db.run(sql`UPDATE erp_command_executions SET status='Accepted', safe_error_code=NULL, completed_at=NULL, created_at=${now()} WHERE client_id=${clientId} AND idempotency_key=${env.idempotencyKey}`);
   return null;
 }
 try {
   await db.run(sql`INSERT INTO erp_command_executions (id,client_id,command_id,request_id,idempotency_key,command_type,entity_type,entity_id,status,request_checksum,created_at) VALUES (${id()},${clientId},${env.commandId},${env.requestId??null},${env.idempotencyKey},${type},${entityType},${entityId??null},'Accepted',${checksum},${now()})`);
 } catch (error:any) {
   // Concurrent first-call collision: someone else already claimed this key. Re-read and apply normal rules instead of surfacing the raw UNIQUE error.
   if(String(error?.message??error).includes("UNIQUE constraint failed")) return startCommand(db,clientId,env,type,entityType,entityId);
   throw error;
 }
 return null;
}
async function finishCommand(db:DbClient, clientId:string, env:Env, type:string, entityType:string, entityId:string|null, meta:any){ await db.run(sql`UPDATE erp_command_executions SET status='Succeeded', entity_type=${entityType}, entity_id=${entityId}, result_reference=${entityId}, safe_result_metadata=${safe(meta)}, safe_error_code=NULL, completed_at=${now()} WHERE client_id=${clientId} AND idempotency_key=${env.idempotencyKey}`); await audit(db, clientId, env.requestId, type, "Succeeded", meta); return {status:"Succeeded",...meta}; }
async function failCommand(db:DbClient, clientId:string, env:Env, error:unknown){ await db.run(sql`UPDATE erp_command_executions SET status='Failed', safe_error_code=${safeErrorCodeFor(error)}, completed_at=${now()} WHERE client_id=${clientId} AND idempotency_key=${env.idempotencyKey}`); }
function prior(r:any){return {status:r.status, entityId:r.entity_id, resultReference:r.result_reference, metadata:r.safe_result_metadata?JSON.parse(r.safe_result_metadata):{}}}

/**
 * Sprint 51B: synchronous SQLite transaction wrapper for this file's raw-SQL
 * statements. Mirrors the guard used elsewhere (services/unitOfWork.ts,
 * services/productWriteTransactionCapabilityForDb.ts) so an accidentally
 * async callback fails loudly instead of silently breaking atomicity. Local
 * to this file only — not shared across domains.
 */
function runWarehouseTransaction(db:DbClient, work:(tx:any)=>void): void {
  const transaction = db.transaction((tx:any) => {
    const result = work(tx) as unknown;
    if (result instanceof Promise) throw new Error("SQLITE_ASYNC_WAREHOUSE_TRANSACTION_CALLBACK_REJECTED");
  });
  if (typeof transaction === "function") (transaction as () => void)();
}
/** Sprint 51B: synchronous counterpart to the (removed) async event() helper, for use inside runWarehouseTransaction callbacks. Same event schema and payload shape as before. */
function eventInTransaction(tx:any, e:any){ tx.run(sql`INSERT INTO warehouse_events (id,warehouse_id,location_id,product_id,order_id,shipment_id,reservation_id,picking_task_id,packing_task_id,event_type,safe_metadata,created_at) VALUES (${id()},${e.warehouseId??null},${e.locationId??null},${e.productId??null},${e.orderId??null},${e.shipmentId??null},${e.reservationId??null},${e.pickingTaskId??null},${e.packingTaskId??null},${e.eventType},${safe(e.meta)},${now()})`); }

export async function availability(db:DbClient, productId:string){ const p=await get(db, sql`SELECT id, stock_quantity FROM products WHERE id=${productId}`); if(!p) throw new NotFoundError("Product not found"); await expireReservations(db); const r=await get(db, sql`SELECT COALESCE(SUM(quantity),0) reserved, COUNT(*) count FROM stock_reservations WHERE product_id=${productId} AND status='Active'`); const physical=Number(p.stock_quantity??0), reserved=Number(r?.reserved??0); return {productId, physicalQuantity:physical, reservedQuantity:reserved, availableQuantity:Math.max(0, physical-reserved), activeReservationCount:Number(r?.count??0)}; }
export async function createWarehouse(db:DbClient, clientId:string, env:Env){
  const existing=await startCommand(db,clientId,env,"CreateWarehouse","Warehouse"); if(existing) return prior(existing);
  const p=env.payload??{};
  try {
    if(!String(p.code??'').trim()||!String(p.name??'').trim()) throw new BadRequestError("Warehouse code and name are required");
    const wid=id();
    runWarehouseTransaction(db, (tx) => {
      tx.run(sql`INSERT INTO warehouses (id,erp_reference_id,name,code,status,country_code,city,address_summary,created_at,updated_at) VALUES (${wid},${p.erpReferenceId??null},${p.name},${p.code},${p.status??'Active'},${p.countryCode??null},${p.city??null},${p.addressSummary??null},${now()},${now()})`);
      eventInTransaction(tx,{warehouseId:wid,eventType:"WarehouseCreated",meta:{code:p.code}});
    });
    return await finishCommand(db,clientId,env,"CreateWarehouse","Warehouse",wid,{warehouseId:wid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const listWarehouses=(db:DbClient)=>all(db, sql`SELECT * FROM warehouses ORDER BY code`);
export async function getWarehouse(db:DbClient,wid:string){ const w=await get(db,sql`SELECT * FROM warehouses WHERE id=${wid}`); if(!w) throw new NotFoundError("Warehouse not found"); return w; }
export async function updateWarehouseStatus(db:DbClient, clientId:string, env:Env, wid:string, status:string){
  const type=status==='Active'?"ReactivateWarehouse":"DeactivateWarehouse";
  const existing=await startCommand(db,clientId,env,type,"Warehouse",wid); if(existing) return prior(existing);
  try {
    await getWarehouse(db,wid);
    runWarehouseTransaction(db, (tx) => {
      tx.run(sql`UPDATE warehouses SET status=${status}, updated_at=${now()} WHERE id=${wid}`);
      eventInTransaction(tx,{warehouseId:wid,eventType:`Warehouse${status}`,meta:{}});
    });
    return await finishCommand(db,clientId,env,type,"Warehouse",wid,{warehouseId:wid,status});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export async function createWarehouseLocation(db:DbClient, clientId:string, env:Env){
  const existing=await startCommand(db,clientId,env,"CreateWarehouseLocation","WarehouseLocation"); if(existing) return prior(existing);
  const p=env.payload??{};
  try {
    if(!p.warehouseId||!String(p.code??'').trim()||!String(p.name??'').trim()) throw new BadRequestError("warehouseId, code and name are required");
    await getWarehouse(db,p.warehouseId);
    if(p.parentLocationId){ const par=await get(db,sql`SELECT * FROM warehouse_locations WHERE id=${p.parentLocationId}`); if(!par||par.warehouse_id!==p.warehouseId) throw new BadRequestError("Parent location must belong to same warehouse"); }
    const lid=id();
    runWarehouseTransaction(db, (tx) => {
      tx.run(sql`INSERT INTO warehouse_locations (id,warehouse_id,parent_location_id,erp_reference_id,code,name,location_type,status,sort_order,created_at,updated_at) VALUES (${lid},${p.warehouseId},${p.parentLocationId??null},${p.erpReferenceId??null},${p.code},${p.name},${p.locationType??'Bin'},${p.status??'Active'},${p.sortOrder??0},${now()},${now()})`);
      eventInTransaction(tx,{warehouseId:p.warehouseId,locationId:lid,eventType:"LocationCreated",meta:{code:p.code}});
    });
    return await finishCommand(db,clientId,env,"CreateWarehouseLocation","WarehouseLocation",lid,{locationId:lid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const listWarehouseLocations=(db:DbClient, warehouseId?:string)=>all(db, warehouseId?sql`SELECT * FROM warehouse_locations WHERE warehouse_id=${warehouseId} ORDER BY sort_order, code`:sql`SELECT * FROM warehouse_locations ORDER BY warehouse_id, sort_order, code`);
export async function assignProductLocation(db:DbClient, clientId:string, env:Env){
  const existing=await startCommand(db,clientId,env,"AssignProductLocation","ProductLocationAssignment"); if(existing) return prior(existing);
  const p=env.payload??{};
  try {
    const loc=await get(db,sql`SELECT * FROM warehouse_locations WHERE id=${p.warehouseLocationId}`); if(!loc) throw new NotFoundError("Location not found");
    if(loc.status!=="Active") throw new BadRequestError("Inactive location cannot receive assignment");
    const prod=await get(db,sql`SELECT id FROM products WHERE id=${p.productId}`); if(!prod) throw new NotFoundError("Product not found");
    const aid=id();
    runWarehouseTransaction(db, (tx) => {
      if(p.isPrimary) tx.run(sql`UPDATE product_location_assignments SET is_primary=0 WHERE product_id=${p.productId}`);
      tx.run(sql`INSERT OR IGNORE INTO product_location_assignments (id,product_id,warehouse_location_id,is_primary,reference_note,created_at,updated_at) VALUES (${aid},${p.productId},${p.warehouseLocationId},${p.isPrimary?1:0},${p.referenceNote??null},${now()},${now()})`);
      eventInTransaction(tx,{warehouseId:loc.warehouse_id,locationId:p.warehouseLocationId,productId:p.productId,eventType:"ProductLocationAssigned",meta:{isPrimary:!!p.isPrimary}});
    });
    return await finishCommand(db,clientId,env,"AssignProductLocation","ProductLocationAssignment",aid,{assignmentId:aid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const getProductLocations=(db:DbClient, productId:string)=>all(db,sql`SELECT a.*, l.code location_code, l.name location_name, w.code warehouse_code FROM product_location_assignments a JOIN warehouse_locations l ON l.id=a.warehouse_location_id JOIN warehouses w ON w.id=l.warehouse_id WHERE a.product_id=${productId} ORDER BY a.is_primary DESC, w.code, l.code`);
export async function createReservation(db:DbClient, clientId:string, env:Env){
  const existing=await startCommand(db,clientId,env,"CreateReservation","StockReservation"); if(existing) return prior(existing);
  const p=env.payload??{};
  try {
    const qty=Number(p.quantity); if(!Number.isInteger(qty)||qty<=0) throw new BadRequestError("Positive integer quantity is required");
    if(!p.reservationReference||!p.reason) throw new BadRequestError("reservationReference and reason are required");
    const product=await get(db, sql`SELECT id, stock_quantity FROM products WHERE id=${p.productId}`); if(!product) throw new NotFoundError("Product not found");
    await expireReservations(db);
    const rid=id();
    /**
     * Sprint 58B: availability was previously verified via a separate read (availability())
     * BEFORE this transaction, so two concurrent CreateReservation requests for the same
     * product could both observe the same available quantity and both succeed, over-reserving
     * stock (confirmed TOCTOU race). The check now runs inside this same synchronous
     * db.transaction() callback as the insert - the callback executes to completion with no
     * await point (enforced by runWarehouseTransaction's Promise guard), so no other request's
     * code can interleave between the read and the write. Uses tx.all(...) directly (not the
     * async db-level all()/get() helpers) to stay fully synchronous, matching this file's
     * existing tx.run(...) convention inside transaction callbacks.
     */
    runWarehouseTransaction(db, (tx) => {
      const stockRows=tx.all(sql`SELECT stock_quantity FROM products WHERE id=${p.productId}`) as any[];
      const reservedRows=tx.all(sql`SELECT COALESCE(SUM(quantity),0) reserved FROM stock_reservations WHERE product_id=${p.productId} AND status='Active'`) as any[];
      const physical=Number(stockRows[0]?.stock_quantity??0), reserved=Number(reservedRows[0]?.reserved??0);
      const available=Math.max(0, physical-reserved);
      if(qty>available) throw new ConflictError("Reservation exceeds available quantity");
      tx.run(sql`INSERT INTO stock_reservations (id,order_id,product_id,reservation_reference,reason,quantity,status,expires_at,created_at,updated_at) VALUES (${rid},${p.orderId??null},${p.productId},${p.reservationReference},${p.reason},${qty},'Active',${p.expiresAt??null},${now()},${now()})`);
      eventInTransaction(tx,{productId:p.productId,orderId:p.orderId,reservationId:rid,eventType:"ReservationCreated",meta:{quantity:qty,reason:p.reason}});
    });
    return await finishCommand(db,clientId,env,"CreateReservation","StockReservation",rid,{reservationId:rid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const listReservations=(db:DbClient,q:any={})=>all(db,sql`SELECT * FROM stock_reservations WHERE (${q.productId??null} IS NULL OR product_id=${q.productId??null}) AND (${q.orderId??null} IS NULL OR order_id=${q.orderId??null}) AND (${q.status??null} IS NULL OR status=${q.status??null}) ORDER BY created_at DESC LIMIT ${Number(q.limit??100)}`);
export async function changeReservation(db:DbClient, clientId:string, env:Env, rid:string, status:string){
  const type=status==='Released'?"ReleaseReservation":status==='Cancelled'?"CancelReservation":"ConsumeReservation";
  const existing=await startCommand(db,clientId,env,type,"StockReservation",rid); if(existing) return prior(existing);
  try {
    const r=await get(db,sql`SELECT * FROM stock_reservations WHERE id=${rid}`); if(!r) throw new NotFoundError("Reservation not found");
    if(["Expired","Cancelled"].includes(r.status)&&status==='Consumed') throw new BadRequestError("Reservation cannot be consumed");
    runWarehouseTransaction(db, (tx) => {
      if(r.status==='Active') tx.run(sql`UPDATE stock_reservations SET status=${status}, released_at=${status==='Released'?now():r.released_at}, consumed_at=${status==='Consumed'?now():r.consumed_at}, updated_at=${now()} WHERE id=${rid}`);
      eventInTransaction(tx,{productId:r.product_id,orderId:r.order_id,reservationId:rid,eventType:`Reservation${status}`,meta:{}});
    });
    return await finishCommand(db,clientId,env,type,"StockReservation",rid,{reservationId:rid,status});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export async function expireReservations(db:DbClient){ await db.run(sql`UPDATE stock_reservations SET status='Expired', updated_at=${now()} WHERE status='Active' AND expires_at IS NOT NULL AND expires_at < ${now()}`); }
async function orderLines(db:DbClient, orderId:string){ const o=await get(db,sql`SELECT * FROM orders WHERE id=${orderId}`); if(!o) throw new NotFoundError("Order not found"); return all(db,sql`SELECT * FROM order_items WHERE order_id=${orderId}`); }
export async function createPickingTask(db:DbClient, clientId:string, env:Env, orderId:string){
  const existing=await startCommand(db,clientId,env,"CreatePickingTask","PickingTask",orderId); if(existing) return prior(existing);
  try {
    const lines=await orderLines(db,orderId); if(!lines.length) throw new BadRequestError("Order has no items");
    const tid=id();
    /**
     * Sprint 59B: previously nothing prevented a second, independent picking task from being
     * created for an order that already had one - the command-envelope idempotency only guards
     * against retrying the SAME command (same idempotencyKey), not a genuinely new create call.
     * The duplicate check now runs inside this same synchronous transaction as the insert (same
     * technique as the Sprint 58B reservation-race fix) so it cannot be raced. A Cancelled prior
     * task does not block a new one.
     */
    runWarehouseTransaction(db, (tx) => {
      const dup=tx.all(sql`SELECT id FROM picking_tasks WHERE order_id=${orderId} AND status!='Cancelled'`) as any[];
      if(dup.length) throw new ConflictError("An active picking task already exists for this order");
      tx.run(sql`INSERT INTO picking_tasks (id,order_id,status,assigned_client_id,safe_notes,created_at,updated_at) VALUES (${tid},${orderId},'Pending',${clientId},${env.payload?.safeNotes??null},${now()},${now()})`);
      for(const l of lines) tx.run(sql`INSERT INTO picking_task_lines (id,picking_task_id,product_id,order_item_id,requested_quantity,picked_quantity,short_quantity,created_at,updated_at) VALUES (${id()},${tid},${l.product_id},${l.id},${l.quantity},0,0,${now()},${now()})`);
      eventInTransaction(tx,{orderId,pickingTaskId:tid,eventType:"PickingCreated",meta:{lineCount:lines.length}});
    });
    return await finishCommand(db,clientId,env,"CreatePickingTask","PickingTask",tid,{pickingTaskId:tid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const getPickingTask=(db:DbClient,tid:string)=>get(db,sql`SELECT * FROM picking_tasks WHERE id=${tid}`);
export const listPickingTasks=(db:DbClient,q:any={})=>all(db,sql`SELECT * FROM picking_tasks WHERE (${q.orderId??null} IS NULL OR order_id=${q.orderId??null}) ORDER BY created_at DESC LIMIT ${Number(q.limit??100)}`);
/** Sprint 59B: read-only composition (no route previously exposed line data at all, so the
 * admin detail view could not display or act on lines) - same {...task, lines} shape already
 * used by getPurchase() elsewhere in this codebase. getPickingTask itself is unchanged and
 * still used internally (updatePicking's existence check, etc.); only the route-facing detail
 * read is enriched. */
export async function getPickingTaskDetail(db:DbClient,tid:string){ const t=await getPickingTask(db,tid); if(!t) throw new NotFoundError("Picking task not found"); const lines=await all(db,sql`SELECT * FROM picking_task_lines WHERE picking_task_id=${tid} ORDER BY created_at`); return {...t, lines}; }
export async function updatePicking(db:DbClient,clientId:string,env:Env,tid:string, action:string, lineId?:string){
  const existing=await startCommand(db,clientId,env,action,"PickingTask",tid); if(existing) return prior(existing);
  try {
    const t=await getPickingTask(db,tid); if(!t) throw new NotFoundError("Picking task not found");
    let confirmQty:number|undefined, shortQty:number|undefined;
    if(action==='ConfirmPickedLine'){ const p=env.payload??{}; const l=await get(db,sql`SELECT * FROM picking_task_lines WHERE id=${lineId} AND picking_task_id=${tid}`); const q=Number(p.pickedQuantity??l.requested_quantity); if(q<0||q>l.requested_quantity) throw new BadRequestError("pickedQuantity cannot exceed requestedQuantity"); confirmQty=q; }
    if(action==='MarkPickingShort'){ const p=env.payload??{}; const l=await get(db,sql`SELECT * FROM picking_task_lines WHERE id=${lineId} AND picking_task_id=${tid}`); const q=Number(p.shortQuantity??(l.requested_quantity-l.picked_quantity)); if(q<0||q>l.requested_quantity) throw new BadRequestError("shortQuantity cannot exceed requestedQuantity"); shortQty=q; }
    if(action==='CompletePickingTask'){ const bad=await get(db,sql`SELECT COUNT(*) c FROM picking_task_lines WHERE picking_task_id=${tid} AND picked_quantity + short_quantity < requested_quantity`); if(Number(bad.c)>0) throw new BadRequestError("Every line must be picked or short"); }
    runWarehouseTransaction(db, (tx) => {
      if(action==='StartPickingTask') tx.run(sql`UPDATE picking_tasks SET status='InProgress', started_at=COALESCE(started_at,${now()}), updated_at=${now()} WHERE id=${tid}`);
      if(action==='ConfirmPickedLine') tx.run(sql`UPDATE picking_task_lines SET picked_quantity=${confirmQty}, short_quantity=0, updated_at=${now()} WHERE id=${lineId}`);
      if(action==='MarkPickingShort') tx.run(sql`UPDATE picking_task_lines SET short_quantity=${shortQty}, updated_at=${now()} WHERE id=${lineId}`);
      if(action==='CompletePickingTask') tx.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${now()}, updated_at=${now()} WHERE id=${tid}`);
      if(action==='CancelPickingTask') tx.run(sql`UPDATE picking_tasks SET status='Cancelled', cancelled_at=${now()}, updated_at=${now()} WHERE id=${tid}`);
      eventInTransaction(tx,{orderId:t.order_id,pickingTaskId:tid,eventType:action,meta:{lineId}});
    });
    return await finishCommand(db,clientId,env,action,"PickingTask",tid,{pickingTaskId:tid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export async function createPackingTask(db:DbClient, clientId:string, env:Env, orderId:string){
  const existing=await startCommand(db,clientId,env,"CreatePackingTask","PackingTask",orderId); if(existing) return prior(existing);
  try {
    const pick=env.payload?.pickingTaskId?await getPickingTask(db,env.payload.pickingTaskId):await get(db,sql`SELECT * FROM picking_tasks WHERE order_id=${orderId} AND status='Picked' ORDER BY completed_at DESC LIMIT 1`); if(!pick) throw new BadRequestError("Completed picking task is required");
    const lines=await all(db,sql`SELECT * FROM picking_task_lines WHERE picking_task_id=${pick.id}`);
    const tid=id();
    /** Sprint 59B: same duplicate-task correction as createPickingTask, scoped to the picking
     * task instead of the order - see that function's comment for the full rationale. */
    runWarehouseTransaction(db, (tx) => {
      const dup=tx.all(sql`SELECT id FROM packing_tasks WHERE picking_task_id=${pick.id} AND status!='Cancelled'`) as any[];
      if(dup.length) throw new ConflictError("An active packing task already exists for this picking task");
      tx.run(sql`INSERT INTO packing_tasks (id,order_id,picking_task_id,status,package_count,created_at,updated_at) VALUES (${tid},${orderId},${pick.id},'Pending',1,${now()},${now()})`);
      for(const l of lines) tx.run(sql`INSERT INTO packing_task_lines (id,packing_task_id,product_id,order_item_id,quantity,created_at) VALUES (${id()},${tid},${l.product_id},${l.order_item_id},${l.picked_quantity},${now()})`);
      eventInTransaction(tx,{orderId,pickingTaskId:pick.id,packingTaskId:tid,eventType:"PackingCreated",meta:{}});
    });
    return await finishCommand(db,clientId,env,"CreatePackingTask","PackingTask",tid,{packingTaskId:tid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const getPackingTask=(db:DbClient,tid:string)=>get(db,sql`SELECT * FROM packing_tasks WHERE id=${tid}`);
export const listPackingTasks=(db:DbClient,q:any={})=>all(db,sql`SELECT * FROM packing_tasks WHERE (${q.orderId??null} IS NULL OR order_id=${q.orderId??null}) ORDER BY created_at DESC LIMIT ${Number(q.limit??100)}`);
/** Sprint 59B: same read-only line composition as getPickingTaskDetail, same rationale. */
export async function getPackingTaskDetail(db:DbClient,tid:string){ const t=await getPackingTask(db,tid); if(!t) throw new NotFoundError("Packing task not found"); const lines=await all(db,sql`SELECT * FROM packing_task_lines WHERE packing_task_id=${tid} ORDER BY created_at`); return {...t, lines}; }
export async function updatePacking(db:DbClient,clientId:string,env:Env,tid:string,action:string){
  const existing=await startCommand(db,clientId,env,action,"PackingTask",tid); if(existing) return prior(existing);
  try {
    const t=await getPackingTask(db,tid); if(!t) throw new NotFoundError("Packing task not found");
    const p=env.payload??{};
    if(action==='UpdatePackingTask'){ if(p.packageCount!==undefined&&Number(p.packageCount)<=0) throw new BadRequestError("packageCount must be positive"); if(p.totalWeight!==undefined&&Number(p.totalWeight)<0) throw new BadRequestError("totalWeight must not be negative"); }
    runWarehouseTransaction(db, (tx) => {
      if(action==='StartPackingTask') tx.run(sql`UPDATE packing_tasks SET status='InProgress', started_at=COALESCE(started_at,${now()}), updated_at=${now()} WHERE id=${tid}`);
      if(action==='UpdatePackingTask') tx.run(sql`UPDATE packing_tasks SET package_count=${p.packageCount??t.package_count}, total_weight=${p.totalWeight??t.total_weight}, dimensions_snapshot=${p.dimensions?JSON.stringify(p.dimensions):t.dimensions_snapshot}, packing_materials_snapshot=${p.materials?JSON.stringify(p.materials):t.packing_materials_snapshot}, updated_at=${now()} WHERE id=${tid}`);
      if(action==='CompletePackingTask') tx.run(sql`UPDATE packing_tasks SET status='Packed', completed_at=${now()}, updated_at=${now()} WHERE id=${tid}`);
      if(action==='MarkPackingReady') tx.run(sql`UPDATE packing_tasks SET status='ReadyForShipment', completed_at=COALESCE(completed_at,${now()}), updated_at=${now()} WHERE id=${tid}`);
      if(action==='CancelPackingTask') tx.run(sql`UPDATE packing_tasks SET status='Cancelled', updated_at=${now()} WHERE id=${tid}`);
      eventInTransaction(tx,{orderId:t.order_id,packingTaskId:tid,eventType:action,meta:{}});
    });
    return await finishCommand(db,clientId,env,action,"PackingTask",tid,{packingTaskId:tid});
  } catch (error) {
    await failCommand(db,clientId,env,error);
    throw error;
  }
}
export const shipmentReadyQueue=(db:DbClient)=>all(db,sql`SELECT o.id orderId,o.order_number orderNumber,p.shipment_id shipmentId,substr(o.guest_email,1,2)||'***' customerMaskedSummary,NULL carrier,NULL trackingAvailability,pt.status packingStatus,p.package_count packageCount,p.total_weight totalWeight,p.completed_at readyAt FROM packing_tasks p JOIN orders o ON o.id=p.order_id LEFT JOIN picking_tasks pt ON pt.id=p.picking_task_id WHERE p.status='ReadyForShipment' ORDER BY p.completed_at DESC`);
export const warehouseEvents=(db:DbClient,q:any={})=>all(db,sql`SELECT * FROM warehouse_events WHERE (${q.productId??null} IS NULL OR product_id=${q.productId??null}) AND (${q.orderId??null} IS NULL OR order_id=${q.orderId??null}) ORDER BY created_at DESC LIMIT ${Number(q.limit??100)} OFFSET ${Number(q.offset??0)}`);
