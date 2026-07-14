import { api } from "./api";
export function landedCostCompleteness(cost: { complete?: boolean; missing?: string[] }) { return cost.complete ? "Complete" : `Missing: ${(cost.missing ?? []).join(", ")}`; }
export function workflowLabel(value?: string | null) { return value ? value.replace(/([a-z])([A-Z])/g, "$1 $2") : "Not set"; }
export function mapAvailability(w: { physicalStock:number; reservedStock?:number; availableStock:number }) { return { physical:w.physicalStock, reserved:w.reservedStock ?? 0, available:w.availableStock, label:`${w.availableStock} available` }; }
export function mapCommandStatus(status: string) { return ["Conflict","Rejected","Failed"].includes(status) ? "Needs attention" : status; }
export function redactConflictError(input: unknown) { return JSON.stringify(input ?? {}).replace(/(key|secret|token|payload)"?:\s*"[^"]+"/gi, "$1:[REDACTED]"); }
export const productWorkspaceLink = (id: string) => `/products/${id}/workspace`;
export const productPhotosLink = (id: string) => `/products/${id}/photos`;
export async function getErpProductWorkspace(id: string) { return api.get(`/api/erp/products/${id}/workspace`); }
export async function getErpLabelData(id: string) { return api.get(`/api/erp/products/${id}/label-data`); }
export function mapPublishReadiness(summary: any) { return summary?.ready ? "Ready" : `Blocked: ${(summary?.missing ?? []).join(", ")}`; }
export function mapRecentCommands(items: any[] = []) { return items.map(({ safeResultMetadata, requestChecksum, ...item }) => ({ ...item, metadata: safeResultMetadata ? "safe metadata available" : undefined, requestChecksum: requestChecksum ? "redacted" : undefined })); }
