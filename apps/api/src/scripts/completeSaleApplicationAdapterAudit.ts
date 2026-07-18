import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export interface CompleteSaleApplicationAdapterAuditResult { readonly status: "PASS" | "FAIL"; readonly issues: readonly string[] }
const rules: ReadonlyArray<readonly [string, RegExp]> = [
  ["database client", /\bDbClient\b/], ["Drizzle", /drizzle-orm/], ["schema", /db\/schema/], ["repository implementation", /repositories\/sales\/(sqlite|postgres)/], ["manual transaction", /\.transaction\s*\(/], ["SQL", /\b(select|insert|update|delete)\s+(from|into|\w+\s+set)\b/i], ["HTTP", /\b(Request|Response|Router|Controller)\b|express/i], ["route", /routes?\//i], ["inventory mutation", /stockMovement|inventoryRepository/i], ["purchase mutation", /purchaseRepository/i], ["refund", /refundRepository/i], ["event dispatch", /EventEmitter|\.emit\s*\(/],
];
export function auditCompleteSaleApplicationAdapterSource(source: string): CompleteSaleApplicationAdapterAuditResult { const issues = rules.filter(([, pattern]) => pattern.test(source)).map(([issue]) => issue); return Object.freeze({ status: issues.length ? "FAIL" : "PASS", issues: Object.freeze(issues) }); }
export function runCompleteSaleApplicationAdapterAudit(): CompleteSaleApplicationAdapterAuditResult { return auditCompleteSaleApplicationAdapterSource(readFileSync(resolve(__dirname, "../application/sales/completeSaleApplicationAdapter.ts"), "utf8")); }
if (require.main === module) { const result = runCompleteSaleApplicationAdapterAudit(); console.log(JSON.stringify(result)); if (result.status === "FAIL") process.exitCode = 1; }
