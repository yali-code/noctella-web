import fs from "node:fs";
import path from "node:path";
export type InventoryUseCaseAuditResult={status:"PASS"|"FAIL";issues:string[]};
const forbidden:[RegExp,string][]=[
  [/from\s+["'][^"']*(db|schema|drizzle|repositories\/inventory\/(factory|drizzle|sqlite|postgres))/i,"forbidden data/repository implementation import"],
  [/DbClient|drizzle|schema\.|\bsql\b/i,"database implementation leakage"],
  [/process\.env/i,"environment access"],
  [/Date\.now\s*\(|new Date\s*\(/,"direct current time"],
  [/randomUUID|crypto\.randomUUID/i,"direct UUID generation"],
  [/from\s+["'][^"']*(routes|controllers|services\/(?!inventoryApplicationContext))/i,"service/route/controller import"],
  [/fetch\s*\(|axios|@aws-sdk|from\s+["']openai["']|from\s+["'][^"']*(ebay|etsy|woocommerce)/i,"HTTP or provider SDK"],
  [/\.commit\s*\(/i,"manual commit"],
  [/\.rollback\s*\(/i,"manual rollback"],
  [/\.transaction\s*\(/i,"nested transaction"],
  [/stockMovements\.(update|delete)|movement\.(update|delete)/i,"movement update/delete"],
  [/marketplace.*(required|must|required)/i,"marketplace mandatory validation"],
  [/Record<string,\s*unknown>|\[key:\s*string\]/i,"unrestricted patch DTO"],
];
export function auditInventoryUseCaseSource(source:string):InventoryUseCaseAuditResult{ const issues=forbidden.filter(([r])=>r.test(source)).map(([,m])=>m); const directMutation=/ctx\.(productRepository|inventoryRepository|stockMovementRepository|stockLocationRepository)\.(create|update|updateWithVersion|incrementQuantity|decrementQuantity|setQuantity|append)\s*\(/.test(source); if(directMutation) issues.push("direct repository mutation outside UnitOfWork"); return {status:issues.length?"FAIL":"PASS",issues}; }
export function runInventoryUseCaseAudit(root=path.resolve(__dirname,"..","application","inventory")):InventoryUseCaseAuditResult{ const files=fs.readdirSync(root).filter(f=>f.endsWith(".ts")&&!f.endsWith(".d.ts")); const issues:string[]=[]; for(const f of files){ const r=auditInventoryUseCaseSource(fs.readFileSync(path.join(root,f),"utf8")); issues.push(...r.issues.map(i=>`${f}: ${i}`)); } return {status:issues.length?"FAIL":"PASS",issues}; }
if(require.main===module){ const r=runInventoryUseCaseAudit(); if(r.status!=="PASS"){ console.error(r.issues.join("\n")); process.exit(1);} console.log("Inventory use case audit PASS"); }
