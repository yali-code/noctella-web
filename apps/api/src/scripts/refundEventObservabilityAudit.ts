import { readFileSync } from "node:fs";
import { join } from "node:path";

type AuditInput = Partial<
  Record<"events" | "observability" | "useCases", string>
>;
const root = process.cwd().endsWith("apps/api")
  ? join(process.cwd(), "src")
  : join(process.cwd(), "apps/api/src");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const prod = (): AuditInput => ({
  events: read("domain/refund/events.ts"),
  observability: [
    read("observability/refund/types.ts"),
    read("observability/refund/refundObservability.ts"),
    read("observability/refund/safeRefundLogger.ts"),
  ].join("\n"),
  useCases: read("use-cases/refund/useCases.ts"),
});
export function auditRefundEventObservability(input: AuditInput = prod()) {
  const violations: string[] = [];
  const eventObs = `${input.events ?? ""}\n${input.observability ?? ""}`;
  const all = `${eventObs}\n${input.useCases ?? ""}`;
  const rejectEventObs = [
    /drizzle-orm|db\/schema|schema\.sqlite|schema\.postgres|DbClient|sql`|UnitOfWork|unitOfWork\.run|transaction\(|fetch\(|axios|httpResponse|providerResponse|rawProvider|authorization\s*[:=]|accessToken\s*[:=]|refreshToken\s*[:=]|password\s*[:=]|secret\s*[:=]|credential\s*[:=]|cardNumber\s*[:=]|cvv\s*[:=]|paymentInstrument\s*[:=]|refundEvents\.(update|delete)|updateRefundEvent|deleteRefundEvent/i,
  ];
  for (const r of rejectEventObs)
    if (r.test(eventObs))
      violations.push(`event/observability forbidden pattern: ${r}`);
  if (
    /refundTransitionRecorded[\s\S]{0,250}unitOfWork\.run|unitOfWork\.run[\s\S]{0,600}refundTransitionRecorded/.test(
      input.useCases ?? "",
    )
  )
    violations.push("success observability inside transaction");
  if (
    /refundEvents\.(update|delete)|updateRefundEvent|deleteRefundEvent/i.test(
      all,
    )
  )
    violations.push("event update/delete API");
  if (/payloadSnapshot:\s*(res|result|response)\b/i.test(input.useCases ?? ""))
    violations.push("raw provider payload stored");
  return {
    pass: violations.length === 0,
    violations,
    checked: [
      "domain/refund/events.ts",
      "observability/refund",
      "use-cases/refund/useCases.ts",
    ],
  };
}
if (process.argv[1]?.endsWith("refundEventObservabilityAudit.ts")) {
  const result = auditRefundEventObservability();
  if (!result.pass) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log("refund event observability audit passed");
}
