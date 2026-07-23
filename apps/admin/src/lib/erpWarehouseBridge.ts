import { ApiError } from "./api";
export const maskCustomer=(v?:string|null)=>!v?"Guest":v.includes("***")?v:`${v.slice(0,2)}***`;
export const redactSafeError=(e:unknown)=>String((e as any)?.message??e).replace(/(api[_-]?key|secret|token)=\S+/gi,"$1=***");
export const mapWarehouse=(w:any)=>({ id:w.id, code:w.code, name:w.name, status:w.status, href:`/warehouses/${w.id}` });
export const mapLocation=(l:any)=>({ id:l.id, warehouseId:l.warehouse_id??l.warehouseId, code:l.code, name:l.name, status:l.status, type:l.location_type??l.locationType });
export const mapAvailability=(a:any)=>({ productId:a.productId, physicalQuantity:Number(a.physicalQuantity??0), reservedQuantity:Number(a.reservedQuantity??0), availableQuantity:Math.max(0,Number(a.availableQuantity??0)) });
export const mapReservation=(r:any)=>({ id:r.id, productId:r.product_id??r.productId, orderId:r.order_id??r.orderId, quantity:Number(r.quantity), status:r.status, expiresAt:r.expires_at??r.expiresAt, canRelease:r.status==="Active", canCancel:r.status==="Active" });
export const mapPicking=(t:any)=>({ id:t.id, orderId:t.order_id??t.orderId, status:t.status, canStart:t.status==="Pending", canComplete:t.status==="InProgress", canCancel:["Pending","InProgress"].includes(t.status) });
export const mapPacking=(t:any)=>({ id:t.id, orderId:t.order_id??t.orderId, status:t.status, packageCount:Number(t.package_count??t.packageCount??1), totalWeight:t.total_weight??t.totalWeight, canStart:t.status==="Pending", canReady:["Packed"].includes(t.status), canCancel:["Pending","InProgress"].includes(t.status) });
export const mapShipmentReady=(q:any)=>({ orderId:q.orderId, orderNumber:q.orderNumber, shipmentId:q.shipmentId, customerMaskedSummary:maskCustomer(q.customerMaskedSummary), packingStatus:q.packingStatus, packageCount:Number(q.packageCount??0), totalWeight:q.totalWeight, readinessIssues:q.readinessIssues??[] });
export const mapWarehouseEvent=(e:any)=>({ id:e.id, type:e.event_type??e.eventType, productId:e.product_id??e.productId, orderId:e.order_id??e.orderId, createdAt:e.created_at??e.createdAt, metadata:e.safe_metadata??e.safeMetadata });
export const query=(path:string, filters:Record<string,unknown>={})=>`${path}?${new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)])).toString()}`;

/**
 * Sprint 58B: /api/erp/* is requireErp-protected on the backend (needs the server-only
 * X-Noctella-ERP-Key). The previous `api.get`/`api.post` calls here had two separate bugs:
 * they targeted the direct backend with no auth header (401), and their paths were missing
 * the `/api` prefix entirely (404 even ignoring auth). These now call the admin's own
 * same-origin proxy routes (apps/admin/src/app/api/erp/{warehouses,warehouse,reservations,
 * commands/**}), which inject the key server-side - same pattern as the purchasing/reports
 * bridge fixes.
 */
async function erpGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError((body as any)?.error ?? res.statusText, res.status, (body as any)?.details);
  return body as T;
}
async function erpPost<T>(path: string, idempotencyKey: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey, payload }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError((body as any)?.error ?? res.statusText, res.status, (body as any)?.details);
  return body as T;
}

export const erpWarehouseApi={
  warehouses:()=>erpGet<any>("/api/erp/warehouses"),
  warehouse:(id:string)=>erpGet<any>(`/api/erp/warehouses/${id}`),
  locations:(f:Record<string,unknown>={})=>erpGet<any>(query("/api/erp/warehouse/locations",f)),
  reservations:(f:Record<string,unknown>={})=>erpGet<any>(query("/api/erp/reservations",f)),
  events:(f:Record<string,unknown>={})=>erpGet<any>(query("/api/erp/warehouse/events",f)),
  picking:(f:Record<string,unknown>={})=>erpGet<any>(query("/api/erp/picking",f)),
  pickingTask:(id:string)=>erpGet<any>(`/api/erp/picking/${id}`),
  packing:(f:Record<string,unknown>={})=>erpGet<any>(query("/api/erp/packing",f)),
  packingTask:(id:string)=>erpGet<any>(`/api/erp/packing/${id}`),
  shipmentReady:()=>erpGet<any>("/api/erp/warehouse/shipment-ready"),
};

export async function createWarehouse(payload:any){ return erpPost<any>("/api/erp/commands/warehouses/create", crypto.randomUUID(), payload); }
export async function activateWarehouse(id:string){ return erpPost<any>(`/api/erp/commands/warehouses/${id}/reactivate`, crypto.randomUUID(), {}); }
export async function deactivateWarehouse(id:string){ return erpPost<any>(`/api/erp/commands/warehouses/${id}/deactivate`, crypto.randomUUID(), {}); }
export async function createLocation(payload:any){ return erpPost<any>("/api/erp/commands/warehouse-locations/create", crypto.randomUUID(), payload); }
/** idempotencyKey must be caller-supplied and stable across retries of the same submission
 * attempt (createReservation replays on a repeated key+payload, conflicts on a repeated key
 * with a different payload) - never generated fresh inside this function. */
export async function createReservation(input:{ idempotencyKey:string; productId:string; quantity:number; reservationReference:string; reason:string; orderId?:string; expiresAt?:string }){
  return erpPost<any>("/api/erp/commands/reservations/create", input.idempotencyKey, input);
}
export async function releaseReservation(id:string){ return erpPost<any>(`/api/erp/commands/reservations/${id}/release`, crypto.randomUUID(), {}); }
export async function cancelReservation(id:string){ return erpPost<any>(`/api/erp/commands/reservations/${id}/cancel`, crypto.randomUUID(), {}); }
export async function consumeReservation(id:string){ return erpPost<any>(`/api/erp/commands/reservations/${id}/consume`, crypto.randomUUID(), {}); }

/**
 * Sprint 59B: every picking/packing mutation below takes a caller-supplied idempotencyKey
 * (never generated inside this file) so a page can keep the same key stable across retries of
 * one submission attempt - required because these are multi-step workflows where a network
 * failure mid-action is more likely to need a safe retry than the single-shot warehouse/
 * reservation actions above.
 */
export async function createPickingTask(orderId:string, idempotencyKey:string, payload:{ safeNotes?:string }={}){ return erpPost<any>(`/api/erp/commands/orders/${orderId}/picking/create`, idempotencyKey, payload); }
export async function startPickingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/picking/${taskId}/start`, idempotencyKey, {}); }
export async function confirmPickedLine(taskId:string, lineId:string, idempotencyKey:string, pickedQuantity:number){ return erpPost<any>(`/api/erp/commands/picking/${taskId}/lines/${lineId}/confirm`, idempotencyKey, { pickedQuantity }); }
export async function markPickingShort(taskId:string, lineId:string, idempotencyKey:string, shortQuantity:number){ return erpPost<any>(`/api/erp/commands/picking/${taskId}/lines/${lineId}/short`, idempotencyKey, { shortQuantity }); }
export async function completePickingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/picking/${taskId}/complete`, idempotencyKey, {}); }
export async function cancelPickingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/picking/${taskId}/cancel`, idempotencyKey, {}); }

export async function createPackingTask(orderId:string, idempotencyKey:string, payload:{ pickingTaskId?:string }={}){ return erpPost<any>(`/api/erp/commands/orders/${orderId}/packing/create`, idempotencyKey, payload); }
export async function startPackingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/packing/${taskId}/start`, idempotencyKey, {}); }
export async function updatePackingTask(taskId:string, idempotencyKey:string, payload:{ packageCount?:number; totalWeight?:number; dimensions?:Record<string,unknown>; materials?:Record<string,unknown> }={}){ return erpPost<any>(`/api/erp/commands/packing/${taskId}/update`, idempotencyKey, payload); }
export async function completePackingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/packing/${taskId}/complete`, idempotencyKey, {}); }
export async function markPackingReady(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/packing/${taskId}/ready-for-shipment`, idempotencyKey, {}); }
export async function cancelPackingTask(taskId:string, idempotencyKey:string){ return erpPost<any>(`/api/erp/commands/packing/${taskId}/cancel`, idempotencyKey, {}); }
