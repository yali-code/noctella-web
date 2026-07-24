import { ApiError } from "./api";
export function maskCustomerValue(v?: string | null) { return v ? v.replace(/^(.).*(.)$/, "$1***$2") : "—"; }
export function mapCustomer(row:any){ return { id:row.id, name:row.name ?? "Unnamed", email:row.email ?? "—", phone:row.phone ?? "—", erpReferenceId:row.erpReferenceId ?? "—", href:`/customers/${row.id}` }; }
export function mapTimelineItem(row:any){ return { type:row.type, when:row.occurredAt ?? "—", label:`${row.type} ${row.entityId ?? ""}`.trim(), readOnly: row.readOnly !== false }; }
export function mapAnalytics(row:any){ return { lifetimeValue: row?.lifetimeValue == null ? "Incomplete" : `€${Number(row.lifetimeValue).toFixed(2)}`, orderCount: row?.orderCount ?? "Incomplete", averageOrderValue: row?.averageOrderValue == null ? "Incomplete" : `€${Number(row.averageOrderValue).toFixed(2)}`, customerScore: row?.customerScore ?? "Incomplete" }; }
export function redactCustomerError(message:string){ return message.replace(/(token|secret|password|oauth|key|vat|tax)[=:][^\s]+/gi,"$1=[REDACTED]"); }

/**
 * Sprint 61B: /api/erp/* is requireErp-protected on the backend (needs the server-only
 * X-Noctella-ERP-Key). Every customerApi call here previously targeted the direct backend with
 * no auth header (401 on every real request) - the same bug class fixed for purchasing/warehouse
 * in Sprints 57B/58B, but affecting this domain's entire admin surface. These now call the
 * admin's own same-origin proxy routes (apps/admin/src/app/api/erp/customers/**,
 * .../commands/customers/**), which inject the key server-side.
 */
async function erpGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(redactCustomerError((body as any)?.error ?? res.statusText), res.status, (body as any)?.details);
  return body as T;
}
async function erpPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const respBody = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(redactCustomerError((respBody as any)?.error ?? res.statusText), res.status, (respBody as any)?.details);
  return respBody as T;
}

export const customerApi={
  list:(q="")=>erpGet<any>(`/api/erp/customers${q?`?${q}`:""}`),
  detail:(id:string)=>erpGet<any>(`/api/erp/customers/${id}`),
  history:(id:string)=>erpGet<any>(`/api/erp/customers/${id}/history`),
  statistics:(id:string)=>erpGet<any>(`/api/erp/customers/${id}/statistics`),
  preferences:(id:string)=>erpGet<any>(`/api/erp/customers/${id}/preferences`),
  notes:(id:string)=>erpGet<any>(`/api/erp/customers/${id}/notes`),
};

/**
 * Backend-supported match identifiers only (see erpCustomerBridge.ts's mergeCandidates on the
 * API side) - no client-invented matching logic. All fields optional; the backend matches on
 * whichever are provided.
 */
export interface MergeCandidateSearch {
  email?: string;
  phone?: string;
  vatNumber?: string;
  erpReferenceId?: string;
  marketplaceBuyerId?: string;
}
export function searchMergeCandidates(criteria: MergeCandidateSearch) {
  return erpPost<{ candidates: any[]; autoMerge: boolean; executionRequired: boolean }>(`/api/erp/commands/customers/merge-candidates`, { payload: criteria });
}

/**
 * idempotencyKey must be caller-supplied and stable across retries of the same merge attempt
 * (the backend replays a Completed result for a repeated key+payload, and rejects a repeated key
 * with a different payload) - never generated fresh inside this function.
 */
export interface ExecuteMergeInput {
  sourceCustomerId: string;
  targetCustomerId: string;
  idempotencyKey: string;
}
export function executeMerge(input: ExecuteMergeInput) {
  return erpPost<{ status: string; idempotent: boolean; sourceCustomerId: string; targetCustomerId: string }>(
    `/api/erp/commands/customers/merge`,
    { idempotencyKey: input.idempotencyKey, payload: { sourceCustomerId: input.sourceCustomerId, targetCustomerId: input.targetCustomerId } },
  );
}
