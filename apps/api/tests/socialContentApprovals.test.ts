import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentApprovalRepository } from "../src/repositories/social-content/approvals";

describe("Human Approval persistence foundation", () => {
  let db: ReturnType<typeof createTestDb>;
  let repo: ReturnType<typeof createSocialContentApprovalRepository>;
  const input = {
    requestId: "approval-request", contentId: "content", preparedImageId: "prepared",
    contentVersion: 7, approvedByAdminUserId: "human",
  };
  beforeEach(() => {
    db = createTestDb();
    repo = createSocialContentApprovalRepository(db as any, "sqlite");
    db.insert(schema.adminUsers).values({
      id: "human", email: "human@example.test", passwordHash: "test-only", role: "admin",
    }).run();
    db.insert(schema.socialContents).values({
      id: "content", contentType: "post", status: "approved", caption: "Historical editorial text", version: 7,
    }).run();
    db.insert(schema.socialPreparedImages).values({
      id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "fingerprint",
      recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-test.jpg",
    }).run();
  });
  afterEach(() => (db as any).$client.close());
  const insert = () => repo.transaction(function* (tx) { return yield* repo.insert(tx, input); });

  it("persists exact evidence with server ID/time and supports both reads without changing editorial data", async () => {
    const before = db.select().from(schema.socialContents).all();
    const start = Date.now() - 1000;
    const row = await repo.transaction(function* (tx) {
      return yield* repo.insert(tx, { ...input, id: "caller-id", approvedAt: "1900-01-01" } as any);
    });
    expect(row).toMatchObject(input);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(row.approvedAt + "Z")).toBeGreaterThanOrEqual(start);
    expect(Date.parse(row.approvedAt + "Z")).toBeLessThanOrEqual(Date.now());
    expect(await repo.transaction(function* (tx) { return yield* repo.find(tx, row.id); })).toEqual(row);
    expect(await repo.transaction(function* (tx) { return yield* repo.findByRequestId(tx, input.requestId); })).toEqual(row);
    expect(db.select().from(schema.socialContents).all()).toEqual(before);
  });
  it("enforces unique request identity without replacing original evidence", async () => {
    const row = await insert();
    await expect(insert()).rejects.toThrow();
    expect(db.select().from(schema.socialContentApprovals).all()).toEqual([row]);
  });
  it("returns null for unknown evidence", async () => {
    expect(await repo.transaction(function* (tx) { return yield* repo.find(tx, "absent"); })).toBeNull();
    expect(await repo.transaction(function* (tx) { return yield* repo.findByRequestId(tx, "absent"); })).toBeNull();
  });
  it("rejects an artifact belonging to different content", async () => {
    db.insert(schema.socialContents).values({ id: "other", contentType: "post" }).run();
    await expect(repo.transaction(function* (tx) {
      return yield* repo.insert(tx, { ...input, contentId: "other" });
    })).rejects.toThrow("Prepared image does not belong");
    expect(db.select().from(schema.socialContentApprovals).all()).toEqual([]);
  });
  it("requires an existing human reference", async () => {
    await expect(repo.transaction(function* (tx) {
      return yield* repo.insert(tx, { ...input, approvedByAdminUserId: "missing" });
    })).rejects.toThrow();
  });
  it("rejects invalid reviewed versions", async () => {
    await expect(repo.transaction(function* (tx) {
      return yield* repo.insert(tx, { ...input, contentVersion: 0 });
    })).rejects.toThrow("Invalid reviewed content version");
  });
  it.each(["content", "prepared", "human"])("restricts deletion of referenced %s", async (parent) => {
    const row = await insert();
    const table = parent === "content" ? schema.socialContents : parent === "prepared" ? schema.socialPreparedImages : schema.adminUsers;
    expect(() => db.delete(table).where(eq(table.id, parent)).run()).toThrow();
    expect(db.select().from(schema.socialContentApprovals).all()).toEqual([row]);
  });
  it("participates in caller transaction rollback", async () => {
    await expect(repo.transaction(function* (tx) {
      yield* repo.insert(tx, input);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(db.select().from(schema.socialContentApprovals).all()).toEqual([]);
  });
  it("additively upgrades existing data, is repeatable, and never synthesizes approval", () => {
    const client = (db as any).$client;
    client.exec("DROP TABLE social_content_approvals");
    const content = db.select().from(schema.socialContents).all();
    const prepared = db.select().from(schema.socialPreparedImages).all();
    ensureSchema(client);
    ensureSchema(client);
    expect(db.select().from(schema.socialContents).all()).toEqual(content);
    expect(db.select().from(schema.socialPreparedImages).all()).toEqual(prepared);
    expect(db.select().from(schema.socialContentApprovals).all()).toEqual([]);
  });
});
