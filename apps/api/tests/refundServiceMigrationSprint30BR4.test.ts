import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditRefundServiceMigration, resolveRefundServiceMigrationAuditBase } from "../src/scripts/refundServiceMigrationAudit";

const servicePath = join(process.cwd(), "src/services/refundsCompatibility.ts");
const source = () => readFileSync(servicePath, "utf8");
const methods = [
  ["calculateMaximumRefund", "calculateMaximumRefundUseCase"],
  ["validateRefundAmount", "validateRefundAmountUseCase"],
  ["createRefund", "createRefundUseCase"],
  ["getRefund", "getRefundUseCase"],
  ["listRefunds", "listRefundsUseCase"],
  ["submitRefund", "submitRefundUseCase"],
  ["cancelRefund", "cancelRefundUseCase"],
  ["retryRefund", "retryRefundUseCase"],
  ["executeMarketplaceRefund", "executeRefundUseCase"],
];

describe("Sprint 30B-R4 refund service migration", () => {
  test("D: resolves the apps/api base directory from both POSIX and Windows style cwd paths (Sprint 53B)", () => {
    expect(resolveRefundServiceMigrationAuditBase("/home/runner/work/noctella-web/apps/api")).toBe("/home/runner/work/noctella-web/apps/api");
    expect(resolveRefundServiceMigrationAuditBase("C:\\Users\\Admin\\noctella-web\\apps\\api")).toBe("C:\\Users\\Admin\\noctella-web\\apps\\api");
    expect(resolveRefundServiceMigrationAuditBase("/home/runner/work/noctella-web")).toBe(join("/home/runner/work/noctella-web", "apps", "api"));
    expect(resolveRefundServiceMigrationAuditBase("C:\\Users\\Admin\\noctella-web")).toBe(join("C:\\Users\\Admin\\noctella-web", "apps", "api"));
  });
  test.each(methods)("%s delegates to %s", (_method, useCase) => expect(source()).toContain(useCase));
  test.each(["from(orders)", "from(refunds)", "db.select", "db.insert", "db.update", "sql`", "drizzle-orm"])("service has no SQL token %s", (token) => expect(source()).not.toContain(token));
  test.each(["transaction(", "SqliteUnitOfWork", "PostgresUnitOfWork", "commit", "rollback"])("service has no transaction token %s", (token) => expect(source()).not.toContain(token));
  test.each(["getMarketplaceAdapter", "decryptCredential", "fetch(", "encryptedAccessToken", "MarketplaceAdapter"])("service has no provider token %s", (token) => expect(source()).not.toContain(token));
  test("builds application context", () => expect(source()).toContain("buildRefundServiceContext"));
  test("normalizes legacy detail shape", () => expect(source()).toContain("allocations: d.items"));
  test("preserves legacy create signature", () => expect(source()).toContain("createRefund(db: DbClient, input: any)"));
  test("preserves legacy get signature", () => expect(source()).toContain("getRefund(db: DbClient, id: string)"));
  test("preserves legacy list pagination mapping", () => expect(source()).toContain("offset: (page - 1) * pageSize"));
  test("preserves legacy not found errors", () => expect(source()).toContain("new NotFoundError"));
  test("preserves legacy bad request errors", () => expect(source()).toContain("new BadRequestError"));
  test("preserves provider retryable error shape", () => expect(source()).toContain("retryable: true"));
  test("preserves provider terminal error shape", () => expect(source()).toContain("retryable: false"));
  test("delegation is idempotent for retry", () => expect(source()).toContain("retryRefundUseCase"));
  test("audit passes", () => expect(auditRefundServiceMigration().pass).toBe(true));
});
