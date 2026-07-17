import fs from "node:fs";
import path from "node:path";
export type InventoryEventsObservabilityAuditResult = {
  status: "PASS" | "FAIL";
  issues: string[];
};
const forbidden = [
  /EventEmitter/,
  /Kafka|RabbitMQ|Redis|PubSub|queue|webhook|worker/i,
  /fetch\s*\(|axios|@aws-sdk|openai|anthropic/i,
  /Date\.now|new Date\s*\(|randomUUID|crypto\.randomUUID/i,
  /db\/schema|drizzle-orm|\bsql`|DbClient/i,
  /password|secret|credential|token/i,
];
export function auditInventoryEventsObservabilitySource(
  source: string,
): InventoryEventsObservabilityAuditResult {
  const issues = forbidden
    .filter((r) => r.test(source))
    .map((r) => `forbidden:${r}`);
  return { status: issues.length ? "FAIL" : "PASS", issues };
}
export function runInventoryEventsObservabilityAudit(
  root = path.resolve(__dirname, ".."),
): InventoryEventsObservabilityAuditResult {
  const files = [
    "domain/inventory/events.ts",
    "events/inventory/publisher.ts",
    "observability/inventory/types.ts",
    "observability/inventory/inventoryObservability.ts",
    "application/inventory/useCases.ts",
    "services/inventoryApplicationContext.ts",
  ];
  const issues: string[] = [];
  for (const f of files) {
    const r = auditInventoryEventsObservabilitySource(
      fs.readFileSync(path.join(root, f), "utf8"),
    );
    issues.push(...r.issues.map((i) => `${f}: ${i}`));
  }
  const useCases = fs.readFileSync(
    path.join(root, "application/inventory/useCases.ts"),
    "utf8",
  );
  if (!/await ctx\.unitOfWork\.run[\s\S]*await publish/.test(useCases))
    issues.push("events are not visibly published after UnitOfWork");
  return { status: issues.length ? "FAIL" : "PASS", issues };
}
if (require.main === module) {
  const r = runInventoryEventsObservabilityAudit();
  if (r.status !== "PASS") {
    console.error(r.issues.join("\n"));
    process.exit(1);
  }
  console.log("Inventory events observability audit PASS");
}
