import { api, ApiError } from "./api";
export interface ErpIntegrationOverview { version: any; health: any; capabilities: any; clients: any[]; checkpoints: any[]; audit: any[]; mappingSummary: any[]; recentCommandExecutions?: any[]; writeCapabilities?: string[]; }
export function redactErpError(message: string): string { return message.replace(/(X-Noctella-ERP-Key|erp[_-]?key|secret|token)[:=][^\s]+/gi, "$1=[REDACTED]"); }
export function mapVersionStatus(version: any): string { return version?.compatible === false ? "Version mismatch" : "Compatible"; }
export function mapReadOnlyLabel(capabilities: any): string { return capabilities?.writesEnabled ? "Writes enabled" : "Read-only integration foundation"; }
export function mapClientMetadata(client: any) { return { id: client.id, name: client.name, keyVersion: client.keyVersion, isActive: !!client.isActive, lastSeenAt: client.lastSeenAt ?? "Never", secret: undefined }; }
export function mapCapabilities(capabilities: any) { return (capabilities?.modules ?? []).map((m: any) => ({ name: m.name, mode: m.mode })); }
export function mapCheckpoint(row: any) { return { token: row.checkpointToken, acknowledgedAt: row.acknowledgedAt, clientId: row.clientId }; }
export function mapAudit(row: any) { return { action: row.action, result: row.result, requestId: row.requestId, errorCode: row.errorCode, safeMetadata: row.safeMetadata }; }
export function mapFieldOwnership(fields: any[]) { return fields.map((f) => ({ field: f.erpField, owner: f.owner, mode: f.currentSprintMode, risk: f.dataLossRisk })); }
export async function fetchErpIntegrationOverview(): Promise<ErpIntegrationOverview> { try { return await api.get<ErpIntegrationOverview>("/api/erp/admin/overview"); } catch (e) { if (e instanceof ApiError) throw new ApiError(redactErpError(e.message), e.status, e.details); throw e; } }
