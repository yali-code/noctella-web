import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Sprint 53B: same cross-platform base-directory resolution approved in Sprint 52B (refundTransactionAudit.ts), kept local to this script. */
export const resolveInventoryApplicationContextAuditBase = (cwd: string): string =>
  basename(cwd) === "api" && basename(dirname(cwd)) === "apps" ? cwd : join(cwd, "apps", "api");

export interface InventoryApplicationContextAuditResult {
  status: "PASS" | "FAIL";
  issues: string[];
}

const forbidden = [
  { name: "SQL", pattern: /\bsql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bSQL\b/i },
  { name: "Drizzle", pattern: /drizzle|Drizzle/ },
  { name: "DbClient", pattern: /DbClient/ },
  { name: "repository factory", pattern: /createInventoryRepositories|createSqliteInventoryRepositories|createPostgresInventoryRepositories|createInventoryRepositoryBundleForDb/ },
  { name: "service construction", pattern: /new\s+(?!Error\b)[A-Z][A-Za-z]+|create[A-Z][A-Za-z]*Service/ },
  { name: "provider SDK", pattern: /stripe|paypal|adyen|shopify|sdk/i },
  { name: "HTTP", pattern: /fetch\(|axios|node:http|node:https|http\.request|https\.request/ },
  { name: "transaction creation", pattern: /\.transaction\s*\(|transaction\s*:/ },
  { name: "commit", pattern: /\bcommit\s*\(/ },
  { name: "rollback", pattern: /\brollback\s*\(/ },
  { name: "AI SDK", pattern: /openai|anthropic|langchain|ai\s*sdk/i },
];

export function auditInventoryApplicationContextSource(source: string): InventoryApplicationContextAuditResult {
  const issues = forbidden.filter((rule) => rule.pattern.test(source)).map((rule) => rule.name);
  return { status: issues.length === 0 ? "PASS" : "FAIL", issues };
}

export function runInventoryApplicationContextAudit(): InventoryApplicationContextAuditResult {
  const source = readFileSync(join(resolveInventoryApplicationContextAuditBase(process.cwd()), "src/services/inventoryApplicationContext.ts"), "utf8");
  return auditInventoryApplicationContextSource(source);
}

if (process.argv[1]?.endsWith("inventoryApplicationContextAudit.ts")) {
  const result = runInventoryApplicationContextAudit();
  if (result.status === "FAIL") {
    console.error(`Inventory application context audit failed: ${result.issues.join(", ")}`);
    process.exit(1);
  }
  console.log("Inventory application context audit passed");
}
