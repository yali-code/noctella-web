import { readFileSync } from "node:fs";
import path from "node:path";
export type ProductReadAuditResult = { status: "PASS" | "FAIL"; violations: string[]; approvedWriteExceptions: string[] };
const root = process.cwd().endsWith(path.join("apps", "api")) ? process.cwd() : path.join(process.cwd(), "apps", "api");
const readFunctions = ["listProducts","getProductById","listCategories","getCategoryById","listCollections","getCollectionById","listPublicProducts","getPublicProductBySlug","listPublicCategories","getPublicCategoryBySlug","listPublicCollections","getPublicCollectionBySlug","listProductProjections","project","getProductProjection","identityCheck"];
const directPatterns = [/db\.select\(/, /\.from\((products|categories|collections|productPhotos|productImages)\)/, /new\s+Pool\(/, /from\s+["']pg["']/, /sql`/];
const files = ["src/services/products.ts", "src/services/publicCatalog.ts", "src/services/categories.ts", "src/services/collections.ts", "src/services/erpIntegration.ts"];
function bodyFor(source: string, name: string) { const start = source.indexOf(`function ${name}`); if (start < 0) return ""; const next = source.indexOf("\nexport ", start + 10); return source.slice(start, next < 0 ? source.length : next); }
export function auditProductReadSource(sources: Record<string,string>): ProductReadAuditResult {
  const violations: string[] = []; const approvedWriteExceptions: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (!text.includes("ProductReadServiceContext") || !text.includes("context.repositories")) violations.push(`${file}: missing repository read context`);
    for (const fn of readFunctions) {
      const body = bodyFor(text, fn); if (!body) continue;
      for (const pattern of directPatterns) if (pattern.test(body)) violations.push(`${file}:${fn}: direct read persistence usage ${pattern}`);
    }
    if (/from "\.\.\/db\/schema"/.test(text) || /from "\.\.\/db\/client"/.test(text)) approvedWriteExceptions.push(`${file}: mixed service retains direct DB/schema imports for write-only paths`);
  }
  return { status: violations.length ? "FAIL" : "PASS", violations, approvedWriteExceptions };
}
export function runProductReadRepositoryAudit(): ProductReadAuditResult { return auditProductReadSource(Object.fromEntries(files.map((file)=>[file, readFileSync(path.join(root, file), "utf8")]))); }
if (require.main === module) { const result = runProductReadRepositoryAudit(); if (result.violations.length) { console.error(result.violations.join("\n")); process.exit(1); } console.log("Product read repository parity audit PASS"); }
