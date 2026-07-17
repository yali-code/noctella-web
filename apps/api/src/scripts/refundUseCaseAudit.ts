import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const forbidden = [
  /DbClient/, /db\/schema|schema\.sqlite|schema\.postgres/, /drizzle-orm/, /\bsql`/, /repositories\/refund\/(sqlite|postgres|factory)/,
  /\.transaction\s*\(/, /marketplaceAdapters|payment SDK|marketplace SDK/, /fetch\s*\(/, /process\.env/, /finance|invoice|stock|shipment/i, /returnRepositories\..*\.(create|update|delete)/
];
export function auditRefundUseCaseSource(root = join(process.cwd(), process.cwd().endsWith("apps/api") ? "src/use-cases/refund" : "apps/api/src/use-cases/refund")) {
  const violations: string[] = [];
  for (const f of readdirSync(root).filter(f => f.endsWith(".ts"))) {
    const text = readFileSync(join(root, f), "utf8");
    for (const p of forbidden) if (p.test(text)) violations.push(`${f}: ${p}`);
  }
  return { pass: violations.length === 0, violations };
}
export function runRefundUseCaseAudit() { const result = auditRefundUseCaseSource(); if (!result.pass) { console.error(result.violations.join("\n")); process.exit(1); } console.log("refund use-case audit passed"); }
export function createRefundUseCaseAuditFixture(kind: "valid"|"invalid") { const dir = mkdtempSync(join(tmpdir(), "refund-use-case-audit-")); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "fixture.ts"), kind === "valid" ? 'import type { RefundApplicationContext } from "x"; export const ok = (ctx: RefundApplicationContext) => ctx.clock.now();' : 'import { refunds } from "../../db/schema"; export const bad = db.transaction(() => fetch("https://x"));'); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
if (process.argv[1]?.endsWith("refundUseCaseAudit.ts")) runRefundUseCaseAudit();
