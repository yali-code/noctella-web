import fs from "node:fs";
import path from "node:path";

export const inventoryServiceMigrationAuditForbidden = [
  /repositories\/inventory\/(?!.*types)/,
  /DbClient/,
  /drizzle-orm/,
  /\bsql`/,
  /new\s+SqliteUnitOfWork/,
  /createInventoryRepositoryBundleForDb/,
  /new\s+Date\(/,
  /Date\.now/,
  /randomUUID/,
  /\bfetch\(/,
  /axios/,
  /OpenAI|Anthropic|AI SDK/,
  /marketplace validation/i,
];
export function auditInventoryServiceMigrationSource(source: string) { return inventoryServiceMigrationAuditForbidden.filter((rule) => rule.test(source)).map(String); }
export function runInventoryServiceMigrationAudit(file = path.resolve(__dirname, "../services/stockMovements.ts")) { const failures = auditInventoryServiceMigrationSource(fs.readFileSync(file, "utf8")); if (failures.length) throw new Error(`Inventory service migration audit failed: ${failures.join(", ")}`); return { ok: true, checked: file }; }
export function inventoryServiceMigrationAuditFixtures() { return { clean: "export async function x(ctx){ return useCase(ctx).execute({}); }", bad: "new SqliteUnitOfWork(db); Date.now(); randomUUID();" }; }
if (require.main === module) console.log(JSON.stringify(runInventoryServiceMigrationAudit()));
