import { api } from "./api";
export type BackgroundJobView = { id: string; type: string; status: string; channel?: string; productId?: string; externalListingId?: string; attemptCount: number; maxAttempts: number; runAfter: string; lastError?: string; payloadSnapshot?: string; lockedAt?: string; lockedBy?: string };
export type StockSyncConflictView = { id: string; channel: string; productId?: string; externalListingId?: string; conflictType: string; status: string; localStock?: number; marketplaceStock?: number; detailsSnapshot?: string; resolution?: string; detectedAt: string; resolvedAt?: string };
export const canRetryJob = (job: BackgroundJobView) => ["failed", "dead_letter", "cancelled", "retry_pending"].includes(job.status);
export const canCancelJob = (job: BackgroundJobView) => ["pending", "retry_pending", "processing"].includes(job.status);
export const safeError = (value?: string) => value?.replace(/Bearer\s+\S+|token[^,}\s]*/gi, "[redacted]") ?? "";
export const productLink = (id?: string) => id ? `/products/${id}` : "#";
export const listingLink = (id?: string) => id ? `/external-listings?listing=${encodeURIComponent(id)}` : "#";
export async function listBackgroundJobs(query = "") { return api.get<{ items: BackgroundJobView[] }>(`/api/background-jobs${query}`); }
export async function getBackgroundJob(id: string) { return api.get<BackgroundJobView>(`/api/background-jobs/${id}`); }
export async function retryBackgroundJob(id: string) { return api.post(`/api/background-jobs/${id}/retry`, {}); }
export async function cancelBackgroundJob(id: string) { return api.post(`/api/background-jobs/${id}/cancel`, {}); }
export async function getStockSyncStatus() { return api.get<any>("/api/stock-sync/status"); }
export async function listConflicts(query = "") { return api.get<{ items: StockSyncConflictView[] }>(`/api/stock-sync/conflicts${query}`); }
export async function getConflict(id: string) { return api.get<StockSyncConflictView>(`/api/stock-sync/conflicts/${id}`); }
export async function resolveConflict(id: string, action: string) { return api.post(`/api/stock-sync/conflicts/${id}/resolve`, { action }); }
export async function stockSyncAudit() { return api.get<{ items: any[] }>("/api/stock-sync/audit"); }
