import { readFileSync } from "node:fs";
import { join } from "node:path";

const forbidden = [
  [/from\s+["'][^"']*db\/schema|schema\.sqlite|schema\.postgres/, "schema import"],
  [/from\s+["']drizzle-orm|\bsql`|\.select\(|\.insert\(|\.update\(|\.delete\(/, "SQL or query builder"],
  [/new\s+SqliteUnitOfWork|new\s+PostgresUnitOfWork|\.transaction\(|\bcommit\b|\brollback\b/i, "transaction creation"],
  [/repositories\/refund\/(sqlite|postgres|factory)/, "repository implementation"],
  [/getMarketplaceAdapter|MarketplaceAdapter|decryptCredential|fetch\(|encryptedAccessToken|credentials?/i, "provider SDK or credential loading"],
];

export function auditRefundServiceMigration(root = join(process.cwd(), process.cwd().endsWith("apps/api") ? "src/services/refundsCompatibility.ts" : "apps/api/src/services/refundsCompatibility.ts")) {
  const source = readFileSync(root, "utf8");
  const violations = forbidden.filter(([pattern]) => (pattern as RegExp).test(source)).map(([, label]) => label as string);
  const required = ["calculateMaximumRefundUseCase", "validateRefundAmountUseCase", "createRefundUseCase", "getRefundUseCase", "listRefundsUseCase", "submitRefundUseCase", "cancelRefundUseCase", "retryRefundUseCase", "executeRefundUseCase", "buildRefundServiceContext"];
  for (const token of required) if (!source.includes(token)) violations.push(`missing delegation: ${token}`);
  return { pass: violations.length === 0, violations };
}

if (process.argv[1]?.endsWith("refundServiceMigrationAudit.ts")) {
  const result = auditRefundServiceMigration();
  if (!result.pass) { console.error(result.violations.join("\n")); process.exit(1); }
  console.log("refund service migration audit passed");
}
