import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RefundApplicationContextAuditResult { status: "PASS" | "FAIL"; issues: string[] }

const forbidden = [
  { name: "database import", pattern: /\.\.\/db\// },
  { name: "DbClient", pattern: /DbClient/ },
  { name: "Drizzle", pattern: /drizzle|Drizzle/ },
  { name: "schema", pattern: /schema/ },
  { name: "raw SQL", pattern: /\bsql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b/ },
  { name: "provider SDK", pattern: /stripe|paypal|adyen|shopify|sdk/i },
  { name: "HTTP client", pattern: /fetch\(|axios|http\.request|https\.request/ },
  { name: "credential access", pattern: /process\.env|credential|secret|apiKey|token/i },
  { name: "filesystem", pattern: /node:fs|readFile|writeFile/ },
  { name: "network", pattern: /node:net|node:http|node:https/ },
  { name: "repository implementation", pattern: /repositories\/refund\/(sqlite|postgres)|createRefundRepositories/ },
  { name: "persistence", pattern: /\.transaction\(|\.execute\(/ },
];

export function auditRefundApplicationContextSource(source: string): RefundApplicationContextAuditResult {
  const issues = forbidden.filter((rule) => rule.pattern.test(source)).map((rule) => rule.name);
  return { status: issues.length === 0 ? "PASS" : "FAIL", issues };
}

export function runRefundApplicationContextAudit(): RefundApplicationContextAuditResult {
  const source = readFileSync(join(process.cwd(), process.cwd().endsWith("apps/api") ? "src/services/refundApplicationContext.ts" : "apps/api/src/services/refundApplicationContext.ts"), "utf8");
  return auditRefundApplicationContextSource(source);
}

if (process.argv[1]?.endsWith("refundApplicationContextAudit.ts")) {
  const result = runRefundApplicationContextAudit();
  if (result.status === "FAIL") {
    console.error(`Refund application context audit failed: ${result.issues.join(", ")}`);
    process.exit(1);
  }
  console.log("Refund application context audit passed");
}
