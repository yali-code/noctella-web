import { ErpMigrationAction, ErpMigrationPreviewResult, ErpMigrationSeverity, ErpMigrationSourceType } from "@noctella/shared";
import { api, ApiError } from "./api";
export const DRY_RUN_WARNING = "Dry Run only — no data imported and no Execute Import action exists.";
export function redactErpMigrationError(message: string): string { return message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi,"[email]").replace(/(accessToken|refreshToken|authorizationCode|password|secret|apiKey|token)[:=][^\s]+/gi,"$1=[REDACTED]"); }
export function sourceTypeLabel(t: ErpMigrationSourceType|string) { return ({ LocalStorageJson:"ERP localStorage JSON", SupabaseJson:"ERP Supabase JSON", ManualJson:"Manual ERP JSON" } as any)[t] ?? String(t); }
export function actionLabel(a: ErpMigrationAction|string) { return String(a).replace(/([a-z])([A-Z])/g,"$1 $2"); }
export function severityLabel(s: ErpMigrationSeverity|string) { return s === ErpMigrationSeverity.Blocking ? "Blocking error" : String(s); }
export function mapSummary(result: ErpMigrationPreviewResult) { return { ...result.summary, dryRun: result.dryRun, generatedAt: result.generatedAt }; }
export function mapFieldLoss(result: ErpMigrationPreviewResult) { return result.entityPreviews.flatMap(e=>e.mappedFields.filter(f=>f.risk?.includes("FieldLoss") || f.classification==="deferred").map(f=>({ sourceId:e.sourceId, field:f.sourceField, risk:f.risk ?? "Deferred" }))); }
export function piiMaskNotice(result?: ErpMigrationPreviewResult) { return `PII is masked by default${result ? ` (${result.summary.maskedPiiCount} fields)` : ""}.`; }
export function buildMigrationQuery(filters: { entityType?: string; action?: string; severity?: string; page?: number; pageSize?: number }) { const p=new URLSearchParams(); Object.entries(filters).forEach(([k,v])=>{ if(v!==undefined && v!=="") p.set(k,String(v)); }); return p.toString(); }
export function downloadableJson(value: unknown) { return JSON.stringify(value, null, 2); }
export async function validateErpMigration(source: unknown, sourceType=ErpMigrationSourceType.ManualJson) { try { return await api.post("/api/erp/migration/validate", { source, sourceType }); } catch(e) { if (e instanceof ApiError) throw new ApiError(redactErpMigrationError(e.message), e.status, e.details); throw e; } }
export async function previewErpMigration(source: unknown, sourceType=ErpMigrationSourceType.ManualJson) { try { return await api.post<ErpMigrationPreviewResult>("/api/erp/migration/preview", { source, sourceType }); } catch(e) { if (e instanceof ApiError) throw new ApiError(redactErpMigrationError(e.message), e.status, e.details); throw e; } }
export async function fetchErpMigrationConflicts(source: unknown) { return api.post("/api/erp/migration/conflicts", { source }); }
export async function fetchErpMigrationManifest(source: unknown) { return api.post("/api/erp/migration/manifest-preview", { source }); }
export const hasExecuteImportAction = false;
