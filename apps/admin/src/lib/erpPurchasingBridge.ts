import { ApiError } from "./api";
export const allocationMethodLabels: Record<string,string> = { Equal:"Equal split", ByItemCost:"By item cost", ByQuantity:"By quantity", ByWeight:"By weight", Manual:"Manual" };
export function redactSafeError(input: unknown) { return JSON.stringify(input ?? {}).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi,"[redacted-email]").replace(/\b\+?[0-9][0-9 .-]{7,}\b/g,"[redacted-phone]"); }
export function mapSupplier(row:any){ return { id:row.id, name:row.name, status:row.status, type:row.supplierType, location:[row.countryCode,row.city].filter(Boolean).join(" / "), erpReferenceId:row.erpReferenceId ?? "—", purchaseCount:row.purchaseCount ?? 0, lastPurchase:row.lastPurchaseAt ?? "—", href:`/suppliers/${row.id}` }; }
export function mapPurchase(row:any){ return { id:row.id, supplierId:row.supplierId, status:row.status, source:row.sourceType, references:[row.erpReferenceId,row.externalReference,row.invoiceReferenceNumber].filter(Boolean).join(" / ") || "—", dates:[row.orderedAt,row.receivedAt].filter(Boolean).join(" / ") || "—", total:row.totalCost == null ? "Incomplete" : `€${Number(row.totalCost).toFixed(2)}`, href:`/purchases/${row.id}` }; }
export function mapLandedCostSummary(summary:any){ return { complete:!!summary.complete, reconciled:!!summary.reconciled, method:allocationMethodLabels[summary.allocationMethod] ?? summary.allocationMethod, lines:summary.lines ?? [] }; }
export function receiptStatus(purchase:any){ const lines=purchase.lines ?? []; if(!lines.length) return "No lines"; const received=lines.reduce((a:any,l:any)=>a+(l.receivedQuantity??0),0); const total=lines.reduce((a:any,l:any)=>a+(l.quantity??0),0); return `${received}/${total} received`; }
export function productLinkWarning(line:any){ return line.productId ? null : "Unlinked line: receipt will not create stock movement"; }
export function costCompleteness(summary:any){ return summary.complete && summary.reconciled ? "Complete" : "Incomplete landed cost"; }
export function commandStatusLabel(status:string){ return status === "Conflict" ? "Conflict — review required" : status; }
export function supplierHref(id:string){ return `/suppliers/${id}`; } export function purchaseHref(id:string){ return `/purchases/${id}`; } export function productHref(id:string){ return `/products/${id}`; }
export function buildPurchaseQuery(filters:any){ const q=new URLSearchParams(); for(const [k,v] of Object.entries(filters)) if(v) q.set(k,String(v)); return q.toString(); }

/**
 * Sprint 57B: /api/erp/* is requireErp-protected on the backend (needs the
 * server-only X-Noctella-ERP-Key), so the browser cannot call it directly -
 * the previous `api.get` calls here targeted the direct backend with no auth
 * header and would 401. These now call the admin's own same-origin proxy
 * routes (apps/admin/src/app/api/erp/{purchases,suppliers}/**), which inject
 * the key server-side, matching the pattern already proven for finance/
 * invoice commands (erpSalesFinanceBridge.ts) and reports exports.
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

export const purchasingApi = {
  suppliers: (q="") => erpGet<any>(`/api/erp/suppliers${q?`?${q}`:""}`),
  supplier: (id:string) => erpGet<any>(`/api/erp/suppliers/${id}`),
  purchases: (q="") => erpGet<any>(`/api/erp/purchases${q?`?${q}`:""}`),
  purchase: (id:string) => erpGet<any>(`/api/erp/purchases/${id}`),
  landed: (id:string) => erpGet<any>(`/api/erp/purchases/${id}/landed-cost`),
};

export async function createSupplier(payload: any) {
  return erpPost<any>(`/api/erp/commands/suppliers/create`, crypto.randomUUID(), payload);
}
/** expectedUpdatedAt must be the supplier's current updatedAt value (the live bridge-local
 * updateSupplier() checks it by plain equality, not a numeric version - see erpPurchasingBridge.ts). */
export async function updateSupplier(id: string, payload: any, expectedUpdatedAt?: string) {
  return erpPost<any>(`/api/erp/commands/suppliers/${id}/update`, crypto.randomUUID(), { ...payload, expectedUpdatedAt });
}
export async function createPurchase(payload: any) {
  return erpPost<any>(`/api/erp/commands/purchases/create`, crypto.randomUUID(), payload);
}
/** idempotencyKey must be caller-supplied and stable across retries of the same submission
 * attempt (receivePurchaseUseCase replays on a repeated key+payload, conflicts on a repeated
 * key with a different payload) - never generated fresh inside this function. */
export async function receivePurchase(id: string, input: { lines: { purchaseLineId: string; quantityReceived: number }[]; idempotencyKey: string; receivedAt?: string; note?: string | null }) {
  return erpPost<any>(`/api/erp/commands/purchases/${id}/receive`, input.idempotencyKey, input);
}
export async function allocatePurchaseCosts(id: string, payload: { allocationMethod?: string }) {
  return erpPost<any>(`/api/erp/commands/purchases/${id}/allocate`, crypto.randomUUID(), payload);
}
export async function markPurchaseOrdered(id: string) {
  return erpPost<any>(`/api/erp/commands/purchases/${id}/mark-ordered`, crypto.randomUUID(), {});
}
export async function cancelPurchase(id: string) {
  return erpPost<any>(`/api/erp/commands/purchases/${id}/cancel`, crypto.randomUUID(), {});
}
