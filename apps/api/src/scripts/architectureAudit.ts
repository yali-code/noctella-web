import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
const apiRoot = resolve(__dirname, "../..");
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length ? requestedTargets : ["src/services/unitOfWork.ts", "src/services/productPhotoOutboxWorkflow.ts", "src/services/returnsCore.ts", "src/use-cases/return/useCases.ts"];
const rules: Array<[RegExp,string]> = [
  [/from\s+["']sharp["']/, "Sharp import inside UnitOfWork/workflow boundary"],
  [/from\s+["']node:fs|from\s+["']fs["']/, "filesystem import inside UnitOfWork/workflow boundary"],
  [/from\s+["']node:https?|from\s+["']https?["']/, "network client inside UnitOfWork/workflow boundary"],
  [/from\s+["']\.\.\/db\/schema|from\s+["'].*src\/db\/schema/, "DB/schema import inside application use case"],
  [/\brepository\.transaction\s*\(/, "deprecated Repository.transaction use"],
  [/\bSELECT\s+\*\s+FROM\b/i, "raw SQL outside approved repository/migration files"],
];
const approvedRawSql = /(^|\/)(db\/|postgres-migrations\/|outboxRepository\.ts$|migrate\.ts$|schema\.sql$)/;
let failed = false;
for (const file of targets) {
  const text = readFileSync(isAbsolute(file) ? file : resolve(apiRoot, file),"utf8");
  for (const [pattern, message] of rules) {
    if (message.startsWith("raw SQL") && approvedRawSql.test(file)) continue;
    if (pattern.test(text)) { console.error(`${file}: ${message}`); failed = true; }
  }
}
if (failed) process.exit(1);
console.log(`architecture audit passed (${targets.length} files)`);
