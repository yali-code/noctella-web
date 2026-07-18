import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CompleteSaleUseCaseAuditResult { readonly status: "PASS" | "FAIL"; readonly issues: readonly string[] }
const rules: readonly [string, RegExp][] = [
  ["business logic duplicated", /\b(grossRevenue|netRevenue|itemCost|profit)\s*[+\-*/]=?|\.reduce\s*\(/],
  ["coordinator bypassed", /salesCompletion\.commit|repositories\.salesCompletion/],
  ["repositories accessed directly", /salesRepositories|repositories\.sales\.|SaleRepository/],
  ["SQL used", /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|drizzle-orm|db\/schema/i],
  ["Inventory accessed", /inventoryRepository|repositories\/inventory|stockMovement/i],
  ["Purchase accessed", /purchaseRepository|repositories\/purchase/i],
  ["financial formulas duplicated", /(?:grossRevenue|netRevenue|itemCost|profit)\s*=\s*[^;\n]*[+\-*/]/],
  ["replay duplicated", /findByIdempotencyKey|saleCompletionExecutions|payloadFingerprint\s*===/],
  ["events introduced", /EventEmitter|\.emit\s*\(|eventBus|enqueue/i],
  ["architecture violated", /\b(Request|Response|Router|Controller)\b|express|\.transaction\s*\(/i],
];
export function auditCompleteSaleUseCaseSource(source: string): CompleteSaleUseCaseAuditResult { const issues = rules.filter(([, rule]) => rule.test(source)).map(([issue]) => issue); return Object.freeze({ status: issues.length ? "FAIL" : "PASS", issues: Object.freeze(issues) }); }
export function runCompleteSaleUseCaseAudit(): CompleteSaleUseCaseAuditResult { return auditCompleteSaleUseCaseSource(readFileSync(resolve(__dirname, "../application/sales/completeSaleUseCase.ts"), "utf8")); }
if (require.main === module) { const result = runCompleteSaleUseCaseAudit(); console.log(JSON.stringify(result)); if (result.status === "FAIL") process.exitCode = 1; }
