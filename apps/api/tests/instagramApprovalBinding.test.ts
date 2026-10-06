import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";

let db: ReturnType<typeof createTestDb>;
const attempt = (id: string, approvalId: string | null = null) => ({
  id, approvalId, connectionId: "connection", idempotencyKey: id,
  caption: "Reviewed caption", mediaUrl: "https://api.example.test/images/product-photos/prepared.jpg", status: "pending",
});
beforeEach(() => {
  db = createTestDb();
  db.insert(schema.marketplaceConnections).values({
    id: "connection", channel: "instagram", accountLabel: "vault", status: "connected",
  }).run();
  db.insert(schema.adminUsers).values({
    id: "human", email: "human@example.test", passwordHash: "test-only", role: "owner",
  }).run();
  db.insert(schema.socialContents).values({ id: "content", contentType: "post" }).run();
  db.insert(schema.socialPreparedImages).values({
    id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "fingerprint",
    recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prepared.jpg",
  }).run();
  db.insert(schema.socialContentApprovals).values({
    id: "approval", requestId: "approval-request", contentId: "content",
    preparedImageId: "prepared", contentVersion: 1, approvedByAdminUserId: "human",
  }).run();
});
afterEach(() => (db as any).$client.close());

it("persists and reads a valid approval binding", () => {
  db.insert(schema.instagramPublishAttempts).values(attempt("first", "approval")).run();
  expect(db.select().from(schema.instagramPublishAttempts).get()).toMatchObject(attempt("first", "approval"));
});
it("rejects an invalid approval reference", () => {
  expect(() => db.insert(schema.instagramPublishAttempts).values(attempt("first", "missing")).run()).toThrow(/FOREIGN KEY/);
});
it("allows at most one attempt per non-null approval", () => {
  db.insert(schema.instagramPublishAttempts).values(attempt("first", "approval")).run();
  expect(() => db.insert(schema.instagramPublishAttempts).values(attempt("second", "approval")).run()).toThrow(/UNIQUE/);
  expect(db.select().from(schema.instagramPublishAttempts).all()).toHaveLength(1);
});
it("permits multiple unbound attempts while retaining publishing-key uniqueness", () => {
  db.insert(schema.instagramPublishAttempts).values([attempt("first"), attempt("second")]).run();
  expect(db.select().from(schema.instagramPublishAttempts).all().map((row) => row.approvalId)).toEqual([null, null]);
  expect(() => db.insert(schema.instagramPublishAttempts).values({ ...attempt("third"), idempotencyKey: "first" }).run()).toThrow(/UNIQUE/);
});
it("restricts deletion of referenced approval evidence", () => {
  db.insert(schema.instagramPublishAttempts).values(attempt("first", "approval")).run();
  expect(() => db.delete(schema.socialContentApprovals).where(eq(schema.socialContentApprovals.id, "approval")).run()).toThrow(/FOREIGN KEY/);
  expect(db.select().from(schema.socialContentApprovals).all()).toHaveLength(1);
});
it("additively upgrades historical rows and preserves bindings on repeat initialization", () => {
  const client = (db as any).$client;
  // Reproduce the pre-0033 table in this disposable database only.
  client.exec(`
    DROP TABLE instagram_publish_attempts;
    CREATE TABLE instagram_publish_attempts (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES marketplace_connections(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      caption TEXT NOT NULL, media_url TEXT NOT NULL,
      container_id TEXT, published_media_id TEXT, status TEXT NOT NULL, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT
    );
    INSERT INTO instagram_publish_attempts
      (id, connection_id, idempotency_key, caption, media_url, status, container_id, published_media_id, published_at)
      VALUES ('historical', 'connection', 'historical', 'Original caption', 'https://api.example.test/old.jpg',
        'published', '123', '456', '2026-09-01T00:00:00Z');
  `);
  const before = client.prepare("SELECT * FROM instagram_publish_attempts").get();
  ensureSchema(client);
  expect(client.prepare("SELECT * FROM instagram_publish_attempts").get()).toEqual({ ...before, approval_id: null, provider_entry_state: null });
  db.insert(schema.instagramPublishAttempts).values(attempt("bound", "approval")).run();
  ensureSchema(client);
  expect(db.select().from(schema.instagramPublishAttempts).where(eq(schema.instagramPublishAttempts.id, "bound")).get()?.approvalId).toBe("approval");
  expect(() => db.insert(schema.instagramPublishAttempts).values(attempt("duplicate", "approval")).run()).toThrow(/UNIQUE/);
  expect(() => db.insert(schema.instagramPublishAttempts).values(attempt("invalid", "missing")).run()).toThrow(/FOREIGN KEY/);
});
