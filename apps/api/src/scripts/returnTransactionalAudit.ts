import { readFileSync } from "node:fs";
const files = process.argv.slice(2).length ? process.argv.slice(2) : ["src/services/returns.ts","src/services/returnsCore.ts","src/use-cases/return/useCases.ts","src/services/unitOfWork.ts"];
const allowRepository = /src\/repositories\/return\//;
const allowCompatibility = /src\/services\/returnsCompatibility\.ts$/;
const rules: Array<[RegExp,string]> = [
  [/from\s+["']drizzle-orm["']/, "Drizzle import in Return core/use-case path"],
  [/from\s+["']\.\.\/db\/client["']|DbClient/, "DB client import/type in Return core/use-case path"],
  [/from\s+["'].*db\/schema/, "DB schema import in Return core/use-case path"],
  [/\bsql`|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i, "raw SQL in Return core/use-case path"],
  [/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.select\s*\(/, "direct persistence in Return core/use-case path"],
  [/products\.stockQuantity|stockMovements\)/, "direct stock mutation in Return core/use-case path"],
  [/RefundStatus|refunds|createRefund|executeMarketplaceRefund|finance|payment/i, "Refund/Finance/payment logic in Return core/use-case path"],
  [/fetch\s*\(|node:fs|node:http|node:https/, "marketplace/network/filesystem access in Return core/use-case path"],
  [/BEGIN|COMMIT|ROLLBACK/, "manual transaction command in Return core/use-case path"],
  [/enqueue.*before.*commit/i, "enqueue before commit in Return core/use-case path"],
];
let failed=false;
for(const file of files){
  if(allowRepository.test(file) || allowCompatibility.test(file)) continue;
  const text=readFileSync(file,"utf8");
  const effectiveRules=file.endsWith("unitOfWork.ts") ? rules.filter(([,m])=>!m.includes("DB client")&&!m.includes("Drizzle")&&!m.includes("schema")&&!m.includes("direct persistence")&&!m.includes("Refund")) : rules;
  for(const [pattern,message] of effectiveRules){ if(pattern.test(text)){ console.error(`${file}: ${message}`); failed=true; } }
  if(file.endsWith("returnsCore.ts") && !/UseCase/.test(text)){ console.error(`${file}: Return core does not invoke use cases`); failed=true; }
}
if(failed) process.exit(1);
console.log(`return transactional audit passed (${files.length} files)`);
