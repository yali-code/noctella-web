import { api } from "./api";
export type ReturnRow = { id:string; orderId:string; shipmentId?:string; channel?:string; status:string; reason:string; requestedResolution:string; approvedResolution?:string; requestedAt:string; receivedAt?:string; completedAt?:string; lastError?:string; items?: ReturnItemRow[] };
export type ReturnItemRow = { id:string; orderItemId:string; productId?:string; quantityRequested:number; quantityApproved?:number; quantityReceived?:number; condition?:string; stockDisposition?:string; inspectionNote?:string };
export type RefundRow = { id:string; orderId:string; returnRequestId?:string; channel?:string; externalRefundId?:string; type:string; status:string; currency:string; subtotalAmount:number; shippingAmount:number; taxAmount:number; totalAmount:number; lastError?:string; allocations?: unknown[] };
export const safeReturnError = (e?: string) => e ? e.replace(/Bearer\s+\S+|access_token\S*|refresh_token\S*|authorization:\s*\S+/gi,"[redacted]").slice(0,180) : "";
export const buildReturnQuery = (filters: Record<string,string|undefined>) => new URLSearchParams(Object.entries(filters).filter(([,v])=>v) as [string,string][]).toString();
export const returnOrderLink = (r: ReturnRow) => `/orders/${r.orderId}`;
export const returnShipmentLink = (r: ReturnRow) => r.shipmentId ? `/shipments/${r.shipmentId}` : undefined;
export const refundReturnLink = (r: RefundRow) => r.returnRequestId ? `/returns/${r.returnRequestId}` : undefined;
export const canTransitionReturn = (status:string, action:string) => ({ authorize:["requested"], reject:["requested","authorized"], receive:["authorized","in_transit"], inspect:["received","inspecting"], approve:["received","inspecting"], complete:["approved","partially_approved"], cancel:["requested","authorized","awaiting_shipment","in_transit"] } as Record<string,string[]>)[action]?.includes(status) ?? false;
export const canRetryRefund = (r: RefundRow) => ["failed","pending"].includes(r.status);
export const canCancelRefund = (r: RefundRow) => ["draft","pending","failed"].includes(r.status);
export const stockDispositionLabel = (v?: string) => ({ return_to_stock:"Return to stock", quarantine:"Quarantine", damaged:"Damaged", parts:"Parts", discard:"Discard", no_stock_change:"No stock change" } as Record<string,string>)[v ?? ""] ?? "Not inspected";
export const financialAdjustment = (refunds: RefundRow[]) => ({ totalRefunded: refunds.reduce((s,r)=>s+r.totalAmount,0), refundedShipping: refunds.reduce((s,r)=>s+r.shippingAmount,0), refundedTax: refunds.reduce((s,r)=>s+r.taxAmount,0) });
export async function listReturns(filters: Record<string,string|undefined> = {}) { const q = buildReturnQuery(filters); return api.get<ReturnRow[]>(`/returns${q ? `?${q}` : ""}`); }
export async function getReturn(id:string) { return api.get<ReturnRow>(`/returns/${id}`); }
export async function getReturnEvents(id:string) { return api.get<unknown[]>(`/returns/${id}/events`); }
export async function getReturnReadiness(id:string) { return api.get<{ready:boolean; reasons:string[]; allowedActions:string[]}>(`/returns/${id}/readiness`); }
export async function listRefunds(filters: Record<string,string|undefined> = {}) { const q = buildReturnQuery(filters); return api.get<RefundRow[]>(`/refunds${q ? `?${q}` : ""}`); }
export async function getRefund(id:string) { return api.get<RefundRow>(`/refunds/${id}`); }
export async function getSaleReversalReadiness(orderId:string) { return api.get<{ready:boolean; reasons:string[]}>(`/orders/${orderId}/sale-reversal/readiness`); }
