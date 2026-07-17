import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SalesApplicationContextAuditResult {
  status: "PASS" | "FAIL";
  issues: string[];
}

const forbidden = [
  { name: "SQL", pattern: /\bsql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bSQL\b/i },
  { name: "DbClient", pattern: /DbClient/ },
  { name: "Drizzle", pattern: /drizzle|Drizzle/ },
  { name: "HTTP", pattern: /fetch\(|axios|node:http|node:https|http\.request|https\.request|\bRequest\b|\bResponse\b/i },
  { name: "routes", pattern: /routes?/i },
  { name: "controllers", pattern: /controllers?/i },
  { name: "provider SDK", pattern: /stripe|paypal|adyen|provider\s*sdk/i },
  { name: "marketplace SDK", pattern: /shopify|ebay|etsy|woocommerce|marketplace\s*sdk/i },
  { name: "EventEmitter", pattern: /EventEmitter/ },
  { name: "Kafka", pattern: /Kafka/i },
  { name: "RabbitMQ", pattern: /RabbitMQ/i },
  { name: "SNS", pattern: /\bSNS\b/ },
  { name: "Azure", pattern: /Azure/i },
  { name: "OpenTelemetry", pattern: /OpenTelemetry|otel/i },
  { name: "Date.now", pattern: /Date\.now/ },
  { name: "randomUUID", pattern: /randomUUID/ },
  { name: "service construction", pattern: /new\s+(?!Error\b)[A-Z][A-Za-z]+Service|create[A-Z][A-Za-z]*Service/ },
  { name: "use case construction", pattern: /new\s+(?!Error\b)[A-Z][A-Za-z]+UseCase|create[A-Z][A-Za-z]*UseCase/ },
];

export function auditSalesApplicationContextSource(source: string): SalesApplicationContextAuditResult {
  const issues = forbidden.filter((rule) => rule.pattern.test(source)).map((rule) => rule.name);
  if (!/Object\.freeze/.test(source)) issues.push("mutable context");
  return { status: issues.length === 0 ? "PASS" : "FAIL", issues };
}

export function runSalesApplicationContextAudit(): SalesApplicationContextAuditResult {
  const root = process.cwd().endsWith("apps/api") ? process.cwd() : join(process.cwd(), "apps/api");
  const source = readFileSync(join(root, "src/services/salesApplicationContext.ts"), "utf8");
  return auditSalesApplicationContextSource(source);
}

if (process.argv[1]?.endsWith("salesApplicationContextAudit.ts")) {
  const result = runSalesApplicationContextAudit();
  if (result.status === "FAIL") {
    console.error(`Sales application context audit failed: ${result.issues.join(", ")}`);
    process.exit(1);
  }
  console.log("Sales application context audit passed");
}
