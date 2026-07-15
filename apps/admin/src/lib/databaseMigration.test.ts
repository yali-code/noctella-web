import { describe, expect, it } from "vitest";
import { DRY_RUN_WARNING, createSafeManifestDownload, cutoverStateLabels, hasProductionExecuteAction, mapHealth, mapMigrationPreview, mapOverview, mapParitySummary, redactSecretText } from "./databaseMigration";

describe("admin database migration mapping",()=>{
  it("maps database overview",()=>expect(mapOverview({activeDriver:"sqlite"}).activeDriver).toBe("sqlite"));
  it("maps cutover labels",()=>expect(cutoverStateLabels.RollbackMode).toContain("Rollback"));
  it("maps parity summary",()=>expect(mapParitySummary({status:"PASS",tables:[{}],blocking:[],warnings:[{}]}).warnings).toBe(1));
  it("counts parity tables",()=>expect(mapParitySummary({tables:[{},{}]}).tableCount).toBe(2));
  it("maps migration preview dry run",()=>expect(mapMigrationPreview({dryRun:true}).dryRun).toBe(true));
  it("maps table counts",()=>expect(mapMigrationPreview({sourceRowCounts:{orders:2}}).tableCounts.orders).toBe(2));
  it("maps warnings",()=>expect(mapMigrationPreview({warnings:[1]}).warnings.length).toBe(1));
  it("maps blocking issues",()=>expect(mapMigrationPreview({blockingIssues:[1]}).blockingIssues.length).toBe(1));
  it("maps health",()=>expect(mapHealth({schemaVersion:"x"}).schemaVersion).toBe("x"));
  it("maps readiness backup",()=>expect(mapHealth({backup:{sqliteBackupPresent:true}}).backupReady).toBe(true));
  it("maps rollback status",()=>expect(mapHealth({backup:{rollbackManifestPrerequisite:"required"}}).rollbackReady).toBe(true));
  it("generates manifest download",()=>expect(createSafeManifestDownload({a:1}).filename).toContain("dry-run"));
  it("redacts database urls",()=>expect(redactSecretText("postgres://u:p@h/db")).not.toContain("u:p"));
  it("redacts keys",()=>expect(redactSecretText("service_role=abc")).toContain("[REDACTED]"));
  it("renders dry run warning",()=>expect(DRY_RUN_WARNING).toContain("No Data Written"));
  it("omits production execute action",()=>expect(hasProductionExecuteAction(["Run preview"])).toBe(false));

  it("maps NotConfigured health",()=>expect(mapHealth({connectivityStatus:"not-configured"}).supabaseConnection).toBe("not-configured"));
  it("maps Warning overview counts",()=>expect(mapOverview({warningCount:2}).warningCount).toBe(2));
  it("maps Blocking overview counts",()=>expect(mapOverview({blockingIssueCount:1}).blockingIssueCount).toBe(1));
  it("maps Ready state",()=>expect(mapOverview({migrationReadiness:"ready"}).migrationReadiness).toBe("ready"));
  it("labels invalid cutover combinations safely",()=>expect(mapOverview({cutoverState:"Bogus"}).cutoverStateLabel).toBe("SQLite only"));
  it("forces safe manifest dryRun",()=>expect(JSON.parse(createSafeManifestDownload({dryRun:false}).content).dryRun).toBe(true));
});
