import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const repositoryRoot = resolve(__dirname, "../../..");
const apiRoot = resolve(__dirname, "..");
const auditScript = resolve(apiRoot, "src/scripts/architectureAudit.ts");
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
const run=(file:string,cwd:string)=>spawnSync(process.execPath,[tsxCli,auditScript,resolve(__dirname,"architecture-fixtures",file)],{cwd,encoding:"utf8"});
describe("architecture audit fixtures",()=>{
 it.each(["unitOfWorkSharp.ts","unitOfWorkFs.ts","unitOfWorkNetwork.ts","useCaseSchema.ts","repositoryTransaction.ts","rawSql.ts"])("rejects %s from repository and API roots",(name)=>{
   expect(run(name,repositoryRoot).status).toBe(1);
   expect(run(name,apiRoot).status).toBe(1);
 });
 it("resolves the audit and explicit fixture from a temporary working directory",()=>{
   const temporaryDirectory=mkdtempSync(resolve(tmpdir(),"architecture-audit-"));
   try { expect(run("unitOfWorkSharp.ts",temporaryDirectory).status).toBe(1); }
   finally { rmSync(temporaryDirectory,{recursive:true,force:true}); }
 });
});
