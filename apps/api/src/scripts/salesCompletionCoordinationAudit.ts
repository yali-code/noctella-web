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
export function auditSalesCompletionConcurrencySource(contract:string,sqlite:string,postgres:string):SalesCompletionCoordinationAuditResult { const checks:readonly [string,boolean][]=[
  ["missing expectedVersion contract",/readonly expectedVersion:\s*SaleVersion/.test(contract)],
  ["SQLite sale update is not version guarded",/and\(eq\(schema\.orders\.id, input\.snapshot\.saleId\), eq\(schema\.orders\.updatedAt, input\.expectedVersion\)\)/.test(sqlite)],
  ["PostgreSQL sale update is not version guarded",/and\(eq\(schema\.orders\.id, input\.snapshot\.saleId\), eq\(schema\.orders\.updatedAt, new Date\(input\.expectedVersion\)\)\)/.test(postgres)],
  ["SQLite silently accepts zero-row update",/finalized\.changes !== 1[\s\S]*throw new SaleConcurrencyConflictError/.test(sqlite)],
  ["PostgreSQL silently accepts zero-row update",/finalized\.length !== 1[\s\S]*throw new SaleConcurrencyConflictError/.test(postgres)],
  ["SQLite uses manual transaction",!sqlite.includes(".transaction(")],
  ["PostgreSQL uses manual transaction",!postgres.includes(".transaction(")],
]; const issues=checks.filter(([,ok])=>!ok).map(([name])=>name); return Object.freeze({status:issues.length?"FAIL":"PASS",issues:Object.freeze(issues)}); }
export function auditCompletedSaleReplayGuardSource(sqlite:string,postgres:string,sqliteSchema:string,postgresSchema:string):SalesCompletionCoordinationAuditResult { const checks:readonly [string,boolean][]=[
  ["SQLite completed-sale identity is not unique",/uniqueIndex\("idx_sale_completion_executions_sale_unique"\)\.on\(table\.saleId\)/.test(sqliteSchema)],
  ["PostgreSQL completed-sale identity is not unique",/uniqueIndex\("idx_sale_completion_executions_sale_unique"\)\.on\(table\.saleId\)/.test(postgresSchema)],
  ["SQLite lacks persisted completed-sale lookup",/saleCompletionExecutions\.saleId, input\.snapshot\.saleId/.test(sqlite)],
  ["PostgreSQL lacks persisted completed-sale lookup",/saleCompletionExecutions\.saleId, input\.snapshot\.saleId/.test(postgres)],
  ["SQLite lacks explicit duplicate-completion rejection",/throw new SaleAlreadyCompletedConflictError/.test(sqlite)],
  ["PostgreSQL lacks explicit duplicate-completion rejection",/throw new SaleAlreadyCompletedConflictError/.test(postgres)],
  ["SQLite guard is not an atomic reservation",/onConflictDoNothing/.test(sqlite)],
  ["PostgreSQL guard is not an atomic reservation",/onConflictDoNothing/.test(postgres)],
]; const issues=checks.filter(([,ok])=>!ok).map(([name])=>name); return Object.freeze({status:issues.length?"FAIL":"PASS",issues:Object.freeze(issues)}); }
export function runSalesCompletionCoordinationAudit():SalesCompletionCoordinationAuditResult { const root=resolve(__dirname,".."); const source=["application/sales/completionCoordination.ts","application/sales/errors.ts","services/salesApplicationContext.ts"].map(file=>readFileSync(resolve(root,file),"utf8")).join("\n"); const sqlite=readFileSync(resolve(root,"repositories/sales-completion/sqlite.ts"),"utf8"); const postgres=readFileSync(resolve(root,"repositories/sales-completion/postgres.ts"),"utf8"); const base=auditSalesCompletionCoordinationSource(source); const concurrency=auditSalesCompletionConcurrencySource(readFileSync(resolve(root,"application/sales/completionCoordination.ts"),"utf8"),sqlite,postgres); const replayGuard=auditCompletedSaleReplayGuardSource(sqlite,postgres,readFileSync(resolve(root,"db/schema.sqlite.ts"),"utf8"),readFileSync(resolve(root,"db/schema.postgres.ts"),"utf8")); const issues=Object.freeze([...base.issues,...concurrency.issues,...replayGuard.issues]); return Object.freeze({status:issues.length?"FAIL":"PASS",issues}); }
if(require.main===module){const result=runSalesCompletionCoordinationAudit();console.log(JSON.stringify(result));if(result.status==="FAIL")process.exitCode=1;}
