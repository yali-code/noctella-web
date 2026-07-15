import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const run=(file:string)=>spawnSync("npx",["tsx","src/scripts/architectureAudit.ts",file],{cwd:process.cwd(),encoding:"utf8"});
describe("architecture audit fixtures",()=>{
 it.each(["unitOfWorkSharp.ts","unitOfWorkFs.ts","unitOfWorkNetwork.ts","useCaseSchema.ts","repositoryTransaction.ts","rawSql.ts"])("rejects %s",(name)=>{expect(run(`tests/architecture-fixtures/${name}`).status).toBe(1);});
});
