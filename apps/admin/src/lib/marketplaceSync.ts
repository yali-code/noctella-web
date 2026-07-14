import { api } from "./api";
export const retryEligible = (o:{internalOrderId?:string|null; status:string; importStatus?:string; retryable?:boolean; attemptCount?:number}) => !o.internalOrderId && !["cancelled","refunded"].includes(o.status) && o.retryable !== false && (o.attemptCount ?? 0) < 3;
export const unmatchedWarnings = (items:Array<{productId?:string|null; titleSnapshot:string}>) => items.filter((i)=>!i.productId).map((i)=>`Unmatched item: ${i.titleSnapshot}`);
export const internalOrderHref = (id?:string|null) => id ? `/orders/${id}` : undefined;
export const safeError = (s?:string|null) => s ? s.replace(/[A-Za-z0-9+/=_-]{8,}/g,"[redacted]") : "";
export function queryString(filters: Record<string, string | number | undefined>) { const q = new URLSearchParams(); Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); }); const s = q.toString(); return s ? `?${s}` : ""; }
export const mapMarketplaceOrderListItem = (o:any) => ({ id:o.id, externalLabel:o.externalOrderNumber ?? o.externalOrderId, buyer:o.buyerName ?? o.buyerEmail ?? "—", totalLabel:`${o.total} ${o.currency}`, internalOrderHref: internalOrderHref(o.internalOrderId), canRetry: retryEligible(o) });
export const mapMarketplaceOrderDetail = (o:any) => ({ ...o, warnings: unmatchedWarnings(o.items ?? []), internalOrderHref: internalOrderHref(o.internalOrderId), safeLastError: safeError(o.lastError) });
export const mapSyncRun = (r:any) => ({ ...r, safeLastError: safeError(r.lastError), counts: `${r.processedCount}/${r.successCount}/${r.failureCount}` });
export const mapExternalListing = (l:any) => ({ ...l, productHref: `/products/${l.productId}`, syncPath: `/api/external-listings/${l.id}/sync` });
export const listMarketplaceOrders = (q="") => api.get<any>(`/api/marketplace-orders${q}`);
export const getMarketplaceOrder = (id:string) => api.get<any>(`/api/marketplace-orders/${id}`);
export const retryMarketplaceOrder = (id:string) => api.post<any>(`/api/marketplace-orders/${id}/retry`, {});
export const listExternalListings = (q="") => api.get<any>(`/api/external-listings${q}`);
export const syncExternalListing = (id:string) => api.post<any>(`/api/external-listings/${id}/sync`, {});
export const listSyncRuns = (q="") => api.get<any>(`/api/marketplace-sync-runs${q}`);
export const listWebhookEvents = (q="") => api.get<any>(`/api/marketplace-webhook-events${q}`);
