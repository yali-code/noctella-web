import fs from "node:fs"; import path from "node:path";
export interface OrderRepositoryAuditResult{status:"PASS"|"FAIL"; violations:string[]}
const forbidden=[/from "\.\.\/db\/schema/,/db\.select\(/,/db\.insert\(/,/db\.update\(/,/sql`/,/applyStockMovementCompatibility/,/Repository\.transaction/,/fetch\(/,/enqueueProductStockSync[\s\S]*uow\.run/];
export function auditOrderRepositorySource(source:string){ const violations=forbidden.filter(r=>r.test(source)).map(r=>String(r)); return {status:violations.length?"FAIL":"PASS",violations} as OrderRepositoryAuditResult; }
export function runOrderRepositoryAudit(root=path.resolve(__dirname,"..")){ const files=["services/orders.ts","use-cases/order/useCases.ts"].map(f=>path.join(root,f)); const violations=files.flatMap(f=>auditOrderRepositorySource(fs.readFileSync(f,"utf8")).violations.map(v=>`${f}:${v}`)); return {status:violations.length?"FAIL":"PASS",violations} as OrderRepositoryAuditResult; }
if(require.main===module){ const r=runOrderRepositoryAudit(); console.log(JSON.stringify(r,null,2)); if(r.status!=="PASS") process.exit(1); }
