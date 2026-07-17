import fs from "node:fs";
import path from "node:path";
export type PurchaseEventsObservabilityAuditResult = {
  status: "PASS" | "FAIL";
  issues: string[];
};
const forbidden = [
  /EventEmitter/,
  /Kafka|RabbitMQ|Redis|PubSub|queue|webhook|worker|SNS|Azure|OpenTelemetry/i,
  /fetch\s*\(|axios|@aws-sdk|openai|anthropic/i,
  /Date\.now|new Date\s*\(|randomUUID|crypto\.randomUUID/i,
  /db\/schema|drizzle-orm|\bsql`|DbClient/i,
  /repositories\/purchase\/(sqlite|postgres|factory)|controllers|routes|HTTP/i,
  /manual transaction|commit\(\)|rollback\(\)/i,
];
export function auditPurchaseEventsObservabilitySource(
  source: string,
): PurchaseEventsObservabilityAuditResult {
  const issues = forbidden
    .filter((r) => r.test(source))
    .map((r) => `forbidden:${r}`);
  return { status: issues.length ? "FAIL" : "PASS", issues };
}
export function runPurchaseEventsObservabilityAudit(
  root = path.resolve(__dirname, ".."),
): PurchaseEventsObservabilityAuditResult {
  const files = [
    "domain/purchase/events.ts",
    "events/purchase/publisher.ts",
    "observability/purchase/types.ts",
    "observability/purchase/purchaseObservability.ts",
    "application/purchase/useCases.ts",
    "services/purchaseApplicationContext.ts",
  ];
  const issues: string[] = [];
  for (const f of files) {
    const r = auditPurchaseEventsObservabilitySource(
      fs.readFileSync(path.join(root, f), "utf8"),
    );
    issues.push(...r.issues.map((i) => `${f}: ${i}`));
  }
  const useCases = fs.readFileSync(
    path.join(root, "application/purchase/useCases.ts"),
    "utf8",
  );
  if (!/await ctx\.unitOfWork\.run[\s\S]*await dispatchEvent/.test(useCases))
    issues.push("events are not visibly published after UnitOfWork");
  return { status: issues.length ? "FAIL" : "PASS", issues };
}
if (require.main === module) {
  const r = runPurchaseEventsObservabilityAudit();
  if (r.status !== "PASS") {
    console.error(r.issues.join("\n"));
    process.exit(1);
  }
  console.log("Purchase events observability audit PASS");
}
