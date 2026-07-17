import { describe, expect, test } from "vitest";
import { auditInventoryServiceMigrationSource, inventoryServiceMigrationAuditFixtures, runInventoryServiceMigrationAudit } from "../src/scripts/inventoryServiceMigrationAudit";

describe("Sprint 31A-I4 inventory service migration audit", () => {
  test("migration source passes audit", () => expect(runInventoryServiceMigrationAudit().ok).toBe(true));
  test("clean fixture passes", () => expect(auditInventoryServiceMigrationSource(inventoryServiceMigrationAuditFixtures().clean)).toEqual([]));
  for (const token of ["DbClient", "drizzle-orm", "sql`SELECT 1`", "new SqliteUnitOfWork(db)", "createInventoryRepositoryBundleForDb(db)", "Date.now()", "randomUUID()", "fetch('/x')", "axios.get('/x')", "OpenAI", "marketplace validation"]) {
    test(`rejects ${token}`, () => expect(auditInventoryServiceMigrationSource(token).length).toBeGreaterThan(0));
  }
});
