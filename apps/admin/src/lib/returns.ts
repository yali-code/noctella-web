import { api } from "./api";
export type ReturnRow = { id:string; orderId:string; shipmentId?:string; channel?:string; status:string; reason:string; requestedResolution:string; approvedResolution?:string; requestedAt:string; receivedAt?:string; completedAt?:string; lastError?:string; items?: ReturnItemRow[] };
export type ReturnItemRow = { id:string; orderItemId:string; productId?:string; quantityRequested:number; quantityApproved?:number; quantityReceived?:number; condition?:string; stockDisposition?:string; inspectionNote?:string };
export type RefundRow = { id:string; orderId:string; returnRequestId?:string; channel?:string; externalRefundId?:string; type:string; status:string; currency:string; subtotalAmount:number; shippingAmount:number; taxAmount:number; totalAmount:number; lastError?:string; allocations?: unknown[] };
export const safeReturnError = (e?: string) => e ? e.replace(/Bearer\s+\S+|access_token\S*|refresh_token\S*|authorization:\s*\S+/gi,"[redacted]").slice(0,180) : "";
export const buildReturnQuery = (filters: Record<string,string|undefined>) => new URLSearchParams(Object.entries(filters).filter(([,v])=>v) as [string,string][]).toString();
export const returnOrderLink = (r: ReturnRow) => `/orders/${r.orderId}`;
export const returnShipmentLink = (r: ReturnRow) => r.shipmentId ? `/shipments/${r.shipmentId}` : undefined;
export const refundReturnLink = (r: RefundRow) => r.returnRequestId ? `/returns/${r.returnRequestId}` : undefined;
// Sprint 56B: added the "in-transit" entry, verified against markReturnInTransitUseCase's
// allowed-from-statuses in apps/api/src/use-cases/return/useCases.ts (it was previously absent,
// so the in-transit action had no eligibility signal and couldn't be surfaced in the admin UI).
export const canTransitionReturn = (status:string, action:string) => ({ authorize:["requested"], reject:["requested","authorized"], "in-transit":["authorized","awaiting_shipment"], receive:["authorized","in_transit"], inspect:["received","inspecting"], approve:["received","inspecting"], complete:["approved","partially_approved"], cancel:["requested","authorized","awaiting_shipment","in_transit"] } as Record<string,string[]>)[action]?.includes(status) ?? false;
// Sprint 56B: matches submitRefundUseCase's allowed-from-statuses in
// apps/api/src/use-cases/refund/useCases.ts (Draft, Pending, Failed).
export const canSubmitRefund = (r: RefundRow) => ["draft","pending","failed"].includes(r.status);
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

// Sprint 56B: lifecycle mutations for existing return/refund records. Every endpoint below
// resolves its own optimistic-concurrency version by re-reading the row inside the backend's
// transaction (verified in apps/api/src/use-cases/return/useCases.ts and
// apps/api/src/use-cases/refund/useCases.ts) - none of them accept or require a client-supplied
// version field, so none is sent here.
export type ReturnAuthorizeInput = { approvedResolution?: string };
export type ReturnRejectInput = { internalNote?: string };
export type ReturnInTransitInput = { returnCarrierCode?: string; returnTrackingNumber?: string; returnTrackingUrl?: string; buyerShippedAt?: string };
export type ReturnReceiveInput = { receivedAt?: string };
export type ReturnInspectInput = { orderItemId: string; quantityReceived?: number; stockDisposition?: string; condition?: string; inspectionNote?: string };
export type ReturnApproveInput = { partial?: boolean; approvedResolution?: string };
export type ReturnCancelInput = { internalNote?: string };

export async function authorizeReturn(id: string, input: ReturnAuthorizeInput = {}) { return api.post<ReturnRow>(`/returns/${id}/authorize`, input); }
export async function rejectReturn(id: string, input: ReturnRejectInput = {}) { return api.post<ReturnRow>(`/returns/${id}/reject`, input); }
export async function markReturnInTransit(id: string, input: ReturnInTransitInput = {}) { return api.post<ReturnRow>(`/returns/${id}/in-transit`, input); }
export async function receiveReturn(id: string, input: ReturnReceiveInput = {}) { return api.post<ReturnRow>(`/returns/${id}/receive`, input); }
export async function inspectReturnItem(id: string, input: ReturnInspectInput) { return api.post<ReturnRow>(`/returns/${id}/inspect`, input); }
export async function approveReturn(id: string, input: ReturnApproveInput = {}) { return api.post<ReturnRow>(`/returns/${id}/approve`, input); }
export async function completeReturn(id: string) { return api.post<ReturnRow>(`/returns/${id}/complete`, {}); }
export async function cancelReturn(id: string, input: ReturnCancelInput = {}) { return api.post<ReturnRow>(`/returns/${id}/cancel`, input); }

export async function submitRefund(id: string) { return api.post<RefundRow>(`/refunds/${id}/submit`, {}); }
export async function retryRefund(id: string) { return api.post<RefundRow>(`/refunds/${id}/retry`, {}); }
export async function cancelRefund(id: string) { return api.post<RefundRow>(`/refunds/${id}/cancel`, {}); }

/** Backend returns a plain 400 for both an invalid status transition and a stale optimistic-
 * concurrency version (apps/api/src/routes/errorHandler.ts maps BadRequestError to 400 with no
 * distinct code) - this is the only signal available to tell a concurrency conflict apart from
 * an ordinary validation failure, verified against the exact backend message text. */
export const isConcurrencyConflict = (message?: string) => !!message && (/updated by another transaction/i.test(message) || /stale refund version/i.test(message));
