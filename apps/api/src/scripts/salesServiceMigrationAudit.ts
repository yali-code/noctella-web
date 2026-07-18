import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SalesServiceMigrationAuditResult { readonly status:"PASS"|"FAIL"; readonly issues:readonly string[] }

export const salesServiceMigrationRules = Object.freeze([
  ["SQL", /\b(sql|select|insert|update|delete)\s*[(`]/i],
  ["DbClient", /\bDbClient\b/],
  ["Drizzle", /drizzle-orm/i],
  ["schema", /(?:db\/schema|schema\.)/i],
  ["repository implementation", /repositories\/(?:sales|inventory)|createSalesRepositories/i],
  ["direct repository call", /saleRepository\.(?:create|update|updateWithVersion|list|findBy)/],
  ["manual transaction", /\.transaction\s*\(/],
  ["UnitOfWork ownership", /new\s+(?:Sqlite|Postgres)UnitOfWork/],
  ["Inventory access", /inventoryRepositor|products\.purchaseCost/i],
  ["stock mutation", /stockMovements\.(?:write|create)|quantityDelta/],
  ["financial formula", /gross\s*-|net\s*-|profit\s*=|itemCost\s*\+=/],
  ["readiness duplication", /issues\.push\([^)]*(?:unpaid|shipment|cost)/i],
  ["idempotency duplication", /findByIdempotencyKey|requestChecksum\s*!==/],
  ["direct completion persistence", /saleFinancials\).values|completionHistory.*values/i],
  ["provider access", /stripe|paypal|providerSdk/i],
  ["nondeterministic Date.now", /Date\.now\s*\(/],
  ["nondeterministic randomUUID", /randomUUID\s*\(/],
  ["nondeterministic Math.random", /Math\.random\s*\(/],
  ["generic patch", /\.set\s*\(\s*(?:input|patch)\s*\)/],
  ["adapter bypass", /new\s+CompleteSaleUseCase/],
] as const);

export function auditMigratedSalesSurface(source:string):SalesServiceMigrationAuditResult {
  const issues=salesServiceMigrationRules.filter(([,pattern])=>pattern.test(source)).map(([issue])=>issue);
  return Object.freeze({status:issues.length?"FAIL":"PASS",issues:Object.freeze(issues)});
}

const count=(source:string,fragment:string)=>source.split(fragment).length-1;
export function runSalesServiceMigrationAudit():SalesServiceMigrationAuditResult {
  const bridge=readFileSync(resolve(__dirname,"../services/erpSalesFinanceBridge.ts"),"utf8");
  const shipment=readFileSync(resolve(__dirname,"../services/shipmentsCompatibility.ts"),"utf8");
  const composition=readFileSync(resolve(__dirname,"../services/salesServiceApplication.ts"),"utf8");
  const issues:string[]=[];
  if(!bridge.includes("createSalesServiceApplication(db).getSale.execute({saleId:id})"))issues.push("GetSaleUseCase delegation missing");
  if(!bridge.includes("application.listSales.execute"))issues.push("ListSalesUseCase delegation missing");
  if(count(bridge,"out=await completeSale(db,id!)")!==1)issues.push("ERP completion must delegate exactly once");
  const command=bridge.slice(bridge.indexOf("export async function executeSalesCommand"),bridge.indexOf("export { getSaleCompletionReadiness"));
  if(command.includes("createFinanceEntry"))issues.push("ERP completion duplicates finance persistence");
  const completion=shipment.slice(shipment.indexOf("export async function completeSale"),shipment.indexOf("export async function reopenSale"));
  if(count(completion,"new CompleteSaleApplicationAdapter")!==1||count(completion,".execute(orderId)")!==1)issues.push("S3D adapter delegation must occur exactly once");
  for(const symbol of ["CreateSaleUseCase","UpdateSaleUseCase","GetSaleUseCase","ListSalesUseCase","CancelSaleUseCase"]){if(!composition.includes(symbol))issues.push(`${symbol} composition missing`);}
  if(!composition.includes("createSalesApplicationContextForDb"))issues.push("approved Sales composition factory missing");
  return Object.freeze({status:issues.length?"FAIL":"PASS",issues:Object.freeze(issues)});
}

if(require.main===module){const result=runSalesServiceMigrationAudit();console.log(JSON.stringify(result));if(result.status==="FAIL")process.exitCode=1;}
