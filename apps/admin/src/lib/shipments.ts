import { api } from "./api";
export type ShipmentRow = { id:string; orderId:string; channel?:string; carrierCode:string; trackingNumber?:string; status:string; shippedAt?:string; deliveredAt?:string; lastError?:string; marketplaceFulfillmentStatus?: string; shippingCost?: number; currency?: string };
export const safeErrorSummary = (e?: string) => e ? e.replace(/Bearer\s+\S+|access_token\S*|refresh_token\S*/gi,"[redacted]").slice(0,160) : "";
export const canAct = (status:string, action:string) => ({ ready:["draft"], ship:["ready","label_created"], deliver:["in_transit"], fail:["in_transit"], cancel:["draft","ready","label_pending","label_created"], return:["delivered","in_transit"] } as Record<string,string[]>)[action]?.includes(status) ?? false;
export const shipmentOrderLink = (s: ShipmentRow) => `/orders/${s.orderId}`;
export const marketplaceOrderLink = (s: ShipmentRow) => s.channel ? `/marketplace-orders?orderId=${encodeURIComponent(s.orderId)}` : undefined;
export const buildShipmentQuery = (filters: Record<string,string|undefined>) => new URLSearchParams(Object.entries(filters).filter(([,v])=>v) as [string,string][]).toString();
export async function listShipments(filters: Record<string,string|undefined> = {}) { const q = buildShipmentQuery(filters); return api.get<ShipmentRow[]>(`/shipments${q ? `?${q}` : ""}`); }
export async function getShipment(id: string) { return api.get<ShipmentRow & { items: unknown[] }>(`/shipments/${id}`); }
export async function getShipmentEvents(id: string) { return api.get<unknown[]>(`/shipments/${id}/events`); }
export async function getShipmentTracking(id: string) { return api.get<unknown[]>(`/shipments/${id}/tracking`); }
export interface FinancialSummary { revenue: number; itemCost: number; fees: number; shippingCost: number; profit: number | null }
export const financialSummary = (sale: any): FinancialSummary => ({ revenue: sale?.grossRevenue ?? 0, itemCost: sale?.itemCost ?? 0, fees: (sale?.marketplaceFee ?? 0) + (sale?.paymentFee ?? 0) + (sale?.promotedFee ?? 0), shippingCost: sale?.shippingCost ?? 0, profit: sale?.profit ?? null });
export const readinessSummary = (r: any) => ({ ready: Boolean(r?.ready), issues: Array.isArray(r?.issues) ? r.issues : [] });
export const canRetryFulfillment = (s: ShipmentRow) => Boolean(s.channel) && ["failed", "pending", "submitted"].includes(String(s.marketplaceFulfillmentStatus ?? "pending"));
export const trackingTimeline = (updates: Array<{ externalStatus?: string; normalizedStatus?: string }>) => updates.map((u) => ({ externalStatus: u.externalStatus ?? "", status: u.normalizedStatus ?? "unknown" }));
