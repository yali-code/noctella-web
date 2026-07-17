import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd().endsWith("apps/api") ? join(process.cwd(), "src/providers/refund") : join(process.cwd(), "apps/api/src/providers/refund");
const forbidden: Array<[RegExp,string]> = [
  [/(?:\.\.\/)+db\//, "DB import"], [/DbClient|schema|drizzle|sql`|raw SQL/i, "DB/schema/Drizzle/raw SQL"], [/(?:repository implementation|UnitOfWork|createTransaction|transaction\()/i, "repository/UnitOfWork/transaction"], [/stripe|paypal|ebay|etsy|woocommerce|sdk/i, "provider SDK"], [/fetch\(|axios|http\b|https\b|net\b|socket/i, "HTTP/network"], [/process\.env|credential|secret|accessToken|refreshToken|cardNumber|cvv/i, "credential/payment secret"], [/readFile|writeFile|readdir|node:fs/i, "filesystem"]
];
const allowSelfFs = true;
function files(dir:string): string[] { return readdirSync(dir).flatMap((n)=>{ const p=join(dir,n); return statSync(p).isDirectory()?files(p):[p]; }); }
export function auditRefundProviderBoundary(fixtures?: Record<string,string>) { const source = fixtures ?? Object.fromEntries(files(root).filter(f=>f.endsWith('.ts')).map(f=>[f, readFileSync(f,'utf8')])); const failures:string[]=[]; for (const [file,text] of Object.entries(source)) for (const [pattern,label] of forbidden) if(pattern.test(text) && !(allowSelfFs && file.endsWith("refundProviderBoundaryAudit.ts"))) failures.push(`${file}: ${label}`); if(failures.length) throw new Error(`refund provider boundary audit failed:\n${failures.join("\n")}`); return true; }
if (process.argv[1]?.endsWith("refundProviderBoundaryAudit.ts")) { auditRefundProviderBoundary(); console.log("refund provider boundary audit passed"); }
