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
 // Sprint 54B: each fixture is spawned once (from the repository root) instead
 // of twice (from both roots) - cwd-independence itself is proven once below,
 // representatively, rather than re-proving it per fixture. This cuts real
 // subprocess spawns from 13 to 8 without weakening violation-type coverage
 // (all 6 rules) or dropping second-root/temp-directory coverage.
 it.each(["unitOfWorkSharp.ts","unitOfWorkFs.ts","unitOfWorkNetwork.ts","useCaseSchema.ts","repositoryTransaction.ts","rawSql.ts"])("rejects %s from the repository root",(name)=>{
   expect(run(name,repositoryRoot).status).toBe(1);
 });
 it("rejects unitOfWorkSharp.ts from the apps/api root too, proving cwd-independence",()=>{
   expect(run("unitOfWorkSharp.ts",apiRoot).status).toBe(1);
 });
 it("resolves the audit and explicit fixture from a temporary working directory",()=>{
   const temporaryDirectory=mkdtempSync(resolve(tmpdir(),"architecture-audit-"));
   try { expect(run("unitOfWorkSharp.ts",temporaryDirectory).status).toBe(1); }
   finally { rmSync(temporaryDirectory,{recursive:true,force:true}); }
 });
});
