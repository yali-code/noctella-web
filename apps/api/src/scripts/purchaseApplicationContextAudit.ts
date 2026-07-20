import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PurchaseApplicationContextAuditResult {
  status: "PASS" | "FAIL";
  issues: string[];
}

const forbidden = [
  { name: "SQL", pattern: /\bsql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bSQL\b/i },
  { name: "schema", pattern: /schema/i },
  { name: "DbClient", pattern: /DbClient/ },
  { name: "Drizzle", pattern: /drizzle|Drizzle/ },
  { name: "repository implementation", pattern: /repositories\/purchase\/(sqlite|postgres)|createPurchaseRepositories/ },
  { name: "service construction", pattern: /new\s+(?!Error\b)[A-Z][A-Za-z]+|create[A-Z][A-Za-z]*Service/ },
  { name: "HTTP", pattern: /fetch\(|axios|node:http|node:https|http\.request|https\.request/ },
  { name: "provider SDK", pattern: /stripe|paypal|adyen|shopify|sdk/i },
  { name: "AI SDK", pattern: /openai|anthropic|langchain|ai\s*sdk/i },
  { name: "environment loading", pattern: /process\.env|dotenv/ },
  { name: "mutable context", pattern: /\blet\s+context\b|Object\.assign\(|\.push\(|\.splice\(|readonly\s*:\s*false/ },
];

export function auditPurchaseApplicationContextSource(source: string): PurchaseApplicationContextAuditResult {
  const auditedSource = source
    .replace(/import type \{ DbClient \} from "\.\.\/db\/client";/, "")
    .replace(/(inventoryReceiptMutation:\s*\(\s*)db: DbClient,/, "$1");
  const issues = forbidden.filter((rule) => rule.pattern.test(auditedSource)).map((rule) => rule.name);
  if (!/Object\.freeze/.test(source)) issues.push("mutable context");
  return { status: issues.length === 0 ? "PASS" : "FAIL", issues };
}

export function runPurchaseApplicationContextAudit(): PurchaseApplicationContextAuditResult {
  const source = readFileSync(join(process.cwd(), process.cwd().endsWith("apps/api") ? "src/services/purchaseApplicationContext.ts" : "apps/api/src/services/purchaseApplicationContext.ts"), "utf8");
  return auditPurchaseApplicationContextSource(source);
}

if (process.argv[1]?.endsWith("purchaseApplicationContextAudit.ts")) {
  const result = runPurchaseApplicationContextAudit();
  if (result.status === "FAIL") {
    console.error(`Purchase application context audit failed: ${result.issues.join(", ")}`);
    process.exit(1);
  }
  console.log("Purchase application context audit passed");
}
