import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export interface SalesCompletionCoordinationAuditResult { readonly status:"PASS"|"FAIL"; readonly issues:readonly string[] }
const rules: readonly [string,RegExp][] = [
  ["SQL",/\bselect\b.+\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b/i],["DbClient",/\bDbClient\b/],["Drizzle",/drizzle-orm|\bDrizzle\b/i],["schema",/db\/schema|schema\.(sqlite|postgres)/i],
  ["repository implementation",/repositories\/(sales|inventory)\/(sqlite|postgres|factory)/i],["direct Inventory access",/inventoryRepository|repositories\/inventory/i],["stock mutation",/applyStockMovement|stockMovements?\.(create|append|update)/i],
  ["HTTP routes or controllers",/\b(Request|Response|Router)\b|[Ee]xpress|[Cc]ontroller|[Rr]outes?\//],["provider SDK",/stripe|paypal|shopify|ebay-sdk|woocommerce/i],["Kafka queue or worker",/Kafka|EventEmitter|\b(queue|worker|enqueue)\b/i],
  ["Date.now",/Date\.now/],["randomUUID",/randomUUID/],["Math.random",/Math\.random/],["manual transaction",/\.transaction\s*\(/],["mutable context",/\b(let|var)\s+context\b|return\s+\{\s*salesRepositories/i],
  ["silent required no-op",/inspectFulfillment:\s*async\s*\(.*=>\s*(undefined|true|\{)/i],["Complete Sale use case",/class\s+CompleteSaleUseCase|function\s+CompleteSaleUseCase/i],["service migration",/shipmentsCompatibility|erpSalesFinanceBridge/i],
];
export function auditSalesCompletionCoordinationSource(source:string):SalesCompletionCoordinationAuditResult { const issues=rules.filter(([,rule])=>rule.test(source)).map(([name])=>name); return Object.freeze({status:issues.length?"FAIL":"PASS",issues:Object.freeze(issues)}); }
export function runSalesCompletionCoordinationAudit():SalesCompletionCoordinationAuditResult { const root=resolve(__dirname,".."); const source=["application/sales/completionCoordination.ts","application/sales/errors.ts","services/salesApplicationContext.ts"].map(file=>readFileSync(resolve(root,file),"utf8")).join("\n"); return auditSalesCompletionCoordinationSource(source); }
if(require.main===module){const result=runSalesCompletionCoordinationAudit();console.log(JSON.stringify(result));if(result.status==="FAIL")process.exitCode=1;}
