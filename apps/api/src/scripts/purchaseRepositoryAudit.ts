import { readFileSync } from "node:fs"; import { join, posix, win32 } from "node:path";
/**
 * Sprint 69: resolves the repo root from an arbitrary cwd (this script's file list is prefixed
 * "apps/api/...", so it needs the repo root, not the apps/api dir - the inverse direction from
 * the other audit scripts' resolvers, hence not shared with resolveAuditBase in auditPathBase.ts).
 * Explicitly chooses path.win32 or path.posix by the input string's own separator style (never
 * the ambient host platform), so a Windows-style cwd checked on a Linux CI runner is still
 * recognized and walked up using "\" throughout, instead of node:path's host-bound basename/
 * dirname silently failing to recognize it and falling through to a mixed-separator join.
 */
export const resolvePurchaseRepositoryAuditRoot=(cwd:string):string=>{ const p=cwd.includes("\\")?win32:posix; return p.basename(cwd)==="api"&&p.basename(p.dirname(cwd))==="apps"?p.join(cwd,"..",".."):cwd; };
const root=resolvePurchaseRepositoryAuditRoot(process.cwd()); const files=["apps/api/src/repositories/purchase/types.ts","apps/api/src/repositories/purchase/sqlite/index.ts","apps/api/src/repositories/purchase/postgres/index.ts","apps/api/src/repositories/purchase/factory.ts"]; const contract=/DbClient|schema\.|drizzle|sql`|rawQuery|queryBuilder|transaction|commit|rollback|Service|Controller|Route|fetch\(|axios|SDK|PatchRecord|where:/i; const impl=/\.transaction\(|commit\(|rollback\(|applyStockMovement|stockMovements|InventoryUseCase|publish|enqueue|webhook|fetch\(|axios|process\.env\[/i;
export function auditPurchaseRepositorySources(extra:{path:string;content:string;contract?:boolean}[]=[]){ const targets=extra.length?extra:files.map(path=>({path,content:readFileSync(join(root,path),"utf8"),contract:path.endsWith("types.ts")})); const failures:string[]=[]; for(const t of targets){ const rx=t.contract?contract:impl; if(rx.test(t.content)) failures.push(`${t.path}: forbidden repository pattern`); if(t.contract&&/\b(update|patch)\s*\([^)]*Record<string,\s*unknown>/i.test(t.content)) failures.push(`${t.path}: arbitrary patch contract`); if(/PurchaseReceiptRepository[\s\S]*\b(update|delete|remove)\s*\(/.test(t.content)) failures.push(`${t.path}: mutable receipt history`); if(/supplierId:\s*SupplierId;|productId:\s*string;/.test(t.content)) failures.push(`${t.path}: mandatory optional purchase reference`); } return failures; }
if(require.main===module){ const failures=auditPurchaseRepositorySources(); if(failures.length){ console.error(failures.join("\n")); process.exit(1);} console.log("Purchase repository audit passed"); }
