import { describe, expect, test } from "vitest";
import { auditInventoryRepositorySource, inventoryRepositoryAuditFixtures, runInventoryRepositoryAudit } from "../src/scripts/inventoryRepositoryAudit";
describe("Sprint 31A I1 inventory repository audit",()=>{
 test("production audit passes",()=>expect(runInventoryRepositoryAudit().status).toBe("PASS"));
 const cases=[
  ["DbClient in contract fixture fails","type X = DbClient"],["schema in domain fixture fails","import { products } from '../db/schema'"],["SQL in contract fixture fails","const x = sql`select 1`"],["internal transaction fixture fails","db.transaction(()=>{})"],["service import fixture fails","import '../services/products'"],["provider SDK fixture fails","fetch('x')"],["generic query API fixture fails","interface R { query(): void; raw(): void }"],["mandatory marketplace field fixture fails","interface X { ebayTitle: string; etsyTitle: string; wooProductName: string; }"],["movement update/delete fixture fails","interface R { updateMovement(): void; deleteMovement(): void }"]
 ] as const;
 for(const [name,src] of cases) test(name,()=>expect(auditInventoryRepositorySource(src).status).toBe("FAIL"));
 test("executable fixture files are created",()=>{ const f=inventoryRepositoryAuditFixtures(); try{ expect(Object.keys(f.fixtures)).toContain("dbClient"); } finally{ f.cleanup(); } });
});
