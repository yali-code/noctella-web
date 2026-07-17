import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.cwd().endsWith("apps/api")
  ? process.cwd()
  : join(process.cwd(), "apps/api");
const read = (path: string) => readFileSync(join(base, path), "utf8");
const between = (source: string, start: string, end?: string) => {
  const i = source.indexOf(start);
  if (i < 0) return "";
  const j = end ? source.indexOf(end, i + start.length) : -1;
  return j < 0 ? source.slice(i) : source.slice(i, j);
};

export function auditRefundTransactionSafety(
  fixtures?: Record<string, string>,
) {
  const useCases =
    fixtures?.useCases ?? read("src/use-cases/refund/useCases.ts");
  const serviceContext =
    fixtures?.serviceContext ?? read("src/services/refundServiceContext.ts");
  const providers =
    fixtures?.providers ??
    read("src/providers/refund/types.ts") +
      read("src/providers/refund/marketplaceRefundPort.ts") +
      read("src/providers/refund/paymentRefundPort.ts");
  const failures: string[] = [];
  const inTx = (token: string) => {
    const i = useCases.indexOf(token);
    const before = useCases.lastIndexOf("ctx.unitOfWork.run", i);
    const after = useCases.indexOf("});", before);
    return i >= 0 && before >= 0 && (after < 0 || i < after + 3);
  };
  const execute = between(
    useCases,
    "export async function executeRefundUseCase",
  );
  const providerWindow = between(execute, "const req=", "try");
  const providerExecution = between(
    execute,
    "try",
    "const res = toProviderResult",
  );
  const successTx = between(
    execute,
    "RefundStatuses.Succeeded",
    "refundExecutionSucceeded",
  );
  const failureTx = between(
    execute,
    "const providerFailure = normalizeRefundProviderError(e)",
  );

  for (const name of [
    "createRefundUseCase",
    "transition",
    "executeRefundUseCase",
  ])
    if (!useCases.includes(name)) failures.push(`missing ${name}`);
  if ((useCases.match(/ctx\.unitOfWork\.run/g) ?? []).length < 4)
    failures.push("missing UnitOfWork mutation boundaries");
  if (!serviceContext.includes("new SqliteUnitOfWork(db)"))
    failures.push("runtime refund context does not use UnitOfWork");
  for (const mutation of [
    "refunds.create",
    "refundItems.createMany",
    "refundAttempts.create",
    "refundAttempts.update",
    "refundEvents.append",
    "refunds.updateWithVersion",
  ]) {
    if (!useCases.includes(mutation))
      failures.push(`missing mutation path: ${mutation}`);
  }
  for (const token of [
    "refunds.create",
    "refundAttempts.create",
    "refunds.updateWithVersion",
  ])
    if (!inTx(token)) failures.push(`mutation outside UnitOfWork: ${token}`);
  if (
    providerWindow.includes("executeRefund(") ||
    /ctx\.unitOfWork\.run\([\s\S]{0,900}executeRefund\(/.test(useCases)
  )
    failures.push("provider inside transaction");
  if (
    !execute.includes("port.executeRefund(req)") ||
    /ctx\.unitOfWork\.run[\s\S]{0,900}port\.executeRefund\(req\)/.test(useCases)
  )
    failures.push("provider execution is not isolated outside UnitOfWork");
  if (
    !successTx.includes('status:"succeeded"') ||
    !successTx.includes("RefundEvents.Succeeded")
  )
    failures.push("success status/attempt/event not atomic");
  if (
    !failureTx.includes('status:"failed"') ||
    !failureTx.includes("RefundEvents.Failed")
  )
    failures.push("failure status/attempt/event not atomic");
  if (inTx("enqueueRefundExecution"))
    failures.push("queue enqueue before commit");
  if (inTx("cancelRefundExecution"))
    failures.push("queue cancellation before commit");
  for (const raw of [
    ".commit(",
    ".rollback(",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "createTransaction",
    "transaction(",
  ])
    if (useCases.includes(raw))
      failures.push(`manual transaction token: ${raw}`);
  if ((useCases.match(/updateWithVersion/g) ?? []).length < 4)
    failures.push("missing updateWithVersion");
  if (
    providers.includes("UnitOfWork") ||
    providers.includes("Repository") ||
    providers.includes("DbClient")
  )
    failures.push("provider can see transactional persistence boundary");
  if (failures.length)
    throw new Error(`refund transaction audit failed:\n${failures.join("\n")}`);
  return true;
}

if (process.argv[1]?.endsWith("refundTransactionAudit.ts")) {
  auditRefundTransactionSafety();
  console.log("refund transaction audit passed");
}
