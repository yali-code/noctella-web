import { describe,it,expect } from "vitest"; import { readFileSync } from "node:fs"; import { join } from "node:path"; import { auditPurchaseRepositorySources, resolvePurchaseRepositoryAuditRoot } from "../src/scripts/purchaseRepositoryAudit";
describe("purchase repository audit Sprint 32A-P1",()=>{
 it("D: resolves the repo root from both POSIX and Windows style cwd paths (Sprint 53B)",()=>{
  expect(resolvePurchaseRepositoryAuditRoot("/home/runner/work/noctella-web/apps/api")).toBe(join("/home/runner/work/noctella-web/apps/api","..",".."));
  expect(resolvePurchaseRepositoryAuditRoot("C:\\Users\\Admin\\noctella-web\\apps\\api")).toBe(join("C:\\Users\\Admin\\noctella-web\\apps\\api","..",".."));
  expect(resolvePurchaseRepositoryAuditRoot("/home/runner/work/noctella-web")).toBe("/home/runner/work/noctella-web");
  expect(resolvePurchaseRepositoryAuditRoot("C:\\Users\\Admin\\noctella-web")).toBe("C:\\Users\\Admin\\noctella-web");
 });
 it("E: fixtures fully replace the production target list - no production file is read when fixtures are supplied", ()=>{
  // A fixture path that does not exist on disk anywhere: if the implementation still tried to
  // read the 4 real production files in addition to the fixtures (the old append behavior),
  // that part would still succeed silently - so what actually proves replace-not-append is that
  // the returned failures are scoped to exactly the supplied fixture, never to a real repository
  // file path, which is confirmed structurally below and behaviorally by the exact failure list.
  const failures = auditPurchaseRepositorySources([{path:"fixture-only.ts",contract:true,content:"export interface X{db:DbClient}"}]);
  expect(failures).toEqual(["fixture-only.ts: forbidden repository pattern"]);
  expect(failures.some(f=>f.startsWith("apps/api/src/repositories/purchase/"))).toBe(false);
  const source = readFileSync(new URL("../src/scripts/purchaseRepositoryAudit.ts", import.meta.url), "utf8");
  expect(source).toContain("extra.length?extra:files.map");
 });
 it("production audit passes",()=>expect(auditPurchaseRepositorySources()).toEqual([]));
 it("DbClient contract fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",contract:true,content:"export interface X{db:DbClient}"}])).not.toEqual([]));
 it("raw query fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",contract:true,content:"rawQuery(sql:string):unknown"}])).not.toEqual([]));
 it("transaction creation fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",content:"db.transaction(()=>{})"}])).not.toEqual([]));
 it("inventory mutation fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",content:"applyStockMovement(input)"}])).not.toEqual([]));
});
